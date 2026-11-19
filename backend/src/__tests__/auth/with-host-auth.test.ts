import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/run-spec";
import type { HostCaller } from "../../auth/with-host-auth";
import { createAgentRunToken, type AgentRunTokenScope } from "../../metaharness/runs/run-token";

// Live-binding hazard: restore the real modules after this file, so a later test file sees them.
const realWithAuthModule = await import("../../auth/withAuth");
const realDbClientModule = await import("../../db/client");

const LOGIN = "aaa.bbb.ccc";
const SECRET = "with-host-auth-test-secret";
const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";
const OWNER = "user-1";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let failingTables = new Set<string>();
let errorRows: Row[] = [];
let loginChecks = 0;

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const iss: [string, unknown][] = [];
  const matches = () =>
    (tables[table] ?? []).filter((row) => eqs.every(([c, v]) => row[c] === v) && iss.every(([c, v]) => (row[c] ?? null) === v));
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => (eqs.push([col, value]), builder),
    is: (col: string, value: unknown) => (iss.push([col, value]), builder),
    async maybeSingle() {
      if (failingTables.has(table)) return { data: null, error: { message: "boom" } };
      return { data: matches()[0] ?? null, error: null };
    },
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, caller: { userId: string; accessToken: string }) => unknown) => async (request: Request) => {
    loginChecks += 1;
    if (request.headers.get("authorization") !== `Bearer ${LOGIN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handler(request, { userId: OWNER, accessToken: LOGIN });
  },
}));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: (table: string) => {
      if (table === "errors") {
        return { insert: (payload: Row) => (errorRows.push(payload), Promise.resolve({ data: null, error: null })) };
      }
      return queryBuilder(table);
    },
  },
}));

const { withHostAuth } = await import("../../auth/with-host-auth");

let seen: HostCaller[] = [];
const route = withHostAuth((_req, caller) => {
  seen.push(caller);
  return Response.json({ ok: true });
});

function mint(overrides: { runId?: string; workspaceId?: string; expiresAt?: number; secret?: string; scope?: AgentRunTokenScope | null } = {}): string {
  const scope = overrides.scope === null ? undefined : (overrides.scope ?? "host");
  return createAgentRunToken(
    {
      runId: parseAgentRunId(overrides.runId ?? RUN),
      workspaceId: parseWorkspaceId(overrides.workspaceId ?? WS),
      expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
      nonce: "nonce-1",
      scope,
    },
    overrides.secret ?? SECRET,
  );
}

function call(token: string | null, sessionId = SESSION, workspaceId = WS): Promise<Response> {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
  const req = Object.assign(new Request("http://localhost/x", { method: "POST", headers }), {
    params: { id: workspaceId, sessionId },
  });
  return Promise.resolve(route(req as never));
}

const runRow = (overrides: Row = {}): Row => ({ id: RUN, workspace_id: WS, kind: "interactive", status: "running", session_id: SESSION, ...overrides });
const cloudSession = (overrides: Row = {}): Row => ({
  id: SESSION,
  workspace_id: WS,
  owner_user_id: OWNER,
  runtime: "cloud",
  host_id: `cloud:${SESSION}`,
  deleted_at: null,
  ...overrides,
});

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SANDBOX_CALLBACK_SECRET;
  process.env.SANDBOX_CALLBACK_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.SANDBOX_CALLBACK_SECRET;
  else process.env.SANDBOX_CALLBACK_SECRET = savedSecret;
  mock.module("../../auth/withAuth", () => realWithAuthModule);
  mock.module("../../db/client", () => realDbClientModule);
});

beforeEach(() => {
  tables = { agent_runs: [runRow()], sessions: [cloudSession()] };
  failingTables = new Set();
  errorRows = [];
  loginChecks = 0;
  seen = [];
});

describe("a cloud run token", () => {
  it("passes the host caller for a live interactive run on its cloud session", async () => {
    const res = await call(mint());
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { kind: "cloud_host", runId: RUN, sessionId: SESSION, workspaceId: WS, ownerUserId: OWNER, hostId: `cloud:${SESSION}` },
    ]);
    expect(loginChecks).toBe(0);
  });

  it("refuses a run for session A when the route names session B", async () => {
    tables.sessions = [cloudSession(), cloudSession({ id: OTHER_SESSION, host_id: `cloud:${OTHER_SESSION}` })];
    const res = await call(mint(), OTHER_SESSION);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "run_not_for_session" });
    expect(seen).toEqual([]);
    expect(errorRows).toEqual([]);
  });

  it("refuses a run for workspace A when the route names another workspace", async () => {
    tables.sessions = [cloudSession({ workspace_id: "66666666-6666-4666-8666-666666666666" })];
    expect((await call(mint(), SESSION, "66666666-6666-4666-8666-666666666666")).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses a token with no scope, which is a routine run's token, before any lookup", async () => {
    failingTables.add("agent_runs");
    const res = await call(mint({ scope: null }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "token_scope" });
    expect(seen).toEqual([]);
    expect(errorRows).toEqual([]);
  });

  it("refuses the agent's mcp token on a host endpoint, before any lookup", async () => {
    failingTables.add("agent_runs");
    const res = await call(mint({ scope: "mcp" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "token_scope" });
    expect(seen).toEqual([]);
    expect(errorRows).toEqual([]);
  });

  it("refuses an expired token", async () => {
    const res = await call(mint({ expiresAt: Date.now() - 1_000 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_run_token" });
    expect(seen).toEqual([]);
    expect(errorRows).toEqual([]);
  });

  it("refuses a token signed with another secret, without a login check", async () => {
    const res = await call(mint({ secret: "some-other-secret" }));
    expect(res.status).toBe(401);
    expect(loginChecks).toBe(0);
    expect(seen).toEqual([]);
  });

  it("refuses a two-part token that is not a run token, without a login check", async () => {
    expect((await call("abc.def")).status).toBe(401);
    expect((await call(".sig")).status).toBe(401);
    expect(loginChecks).toBe(0);
  });

  it("refuses a routine run", async () => {
    tables.agent_runs = [runRow({ kind: "routine" })];
    const res = await call(mint());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "run_not_interactive" });
  });

  it("refuses a run that has finished", async () => {
    for (const status of ["succeeded", "failed", "stale", "cancelled"]) {
      tables.agent_runs = [runRow({ status })];
      const res = await call(mint());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: "run_not_active" });
    }
    expect(seen).toEqual([]);
  });

  it("accepts each run status that is still going", async () => {
    for (const status of ["queued", "preparing", "running", "validating", "committing"]) {
      tables.agent_runs = [runRow({ status })];
      expect((await call(mint())).status).toBe(200);
    }
  });

  it("refuses a run whose session is a local one", async () => {
    tables.sessions = [cloudSession({ runtime: "local", host_id: "host-1" })];
    const res = await call(mint());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "session_not_cloud" });
  });

  it("refuses a session whose host id is not its cloud host", async () => {
    tables.sessions = [cloudSession({ host_id: "host-1" })];
    expect((await call(mint())).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses a deleted session as not found", async () => {
    tables.sessions = [cloudSession({ deleted_at: "2026-01-01T00:00:00Z" })];
    const res = await call(mint());
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("refuses a token for a run that does not exist", async () => {
    tables.agent_runs = [];
    expect((await call(mint())).status).toBe(401);
  });

  it("records an error and answers 500 when the run lookup fails", async () => {
    failingTables.add("agent_runs");
    const res = await call(mint());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "host_run_lookup_failed" });
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]).toMatchObject({ workspace_id: WS, session_id: SESSION, agent_run_id: RUN, operation: "auth" });
    expect(errorRows[0]!.detail_json).toMatchObject({ code: "host_run_lookup_failed" });
  });

  it("records an error and answers 500 when the session lookup fails", async () => {
    failingTables.add("sessions");
    const res = await call(mint());
    expect(res.status).toBe(500);
    expect(errorRows[0]!.detail_json).toMatchObject({ code: "host_session_lookup_failed" });
  });

  it("records an error and answers 500 when the run token secret is missing", async () => {
    delete process.env.SANDBOX_CALLBACK_SECRET;
    try {
      const res = await call(mint());
      expect(res.status).toBe(500);
      expect(errorRows[0]!.detail_json).toMatchObject({ code: "host_token_check_failed" });
    } finally {
      process.env.SANDBOX_CALLBACK_SECRET = SECRET;
    }
  });
});

describe("a person's login", () => {
  it("goes to withAuth and reaches the handler as a user", async () => {
    const res = await call(LOGIN);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ kind: "user", userId: OWNER, accessToken: LOGIN }]);
    expect(loginChecks).toBe(1);
  });

  it("is refused by withAuth when it does not verify", async () => {
    const res = await call("ddd.eee.fff");
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("is refused by withAuth when no bearer token is sent", async () => {
    expect((await call(null)).status).toBe(401);
    expect(loginChecks).toBe(1);
    expect(seen).toEqual([]);
  });
});
