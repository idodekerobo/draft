import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-2", accessToken: "token-2" };

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const matches = () => (tables[table] ?? []).filter((row) => eqs.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c])));
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => (eqs.push([col, value]), builder),
    in: (col: string, values: unknown[]) => (ins.push([col, values]), builder),
    async maybeSingle() {
      return { data: matches()[0] ?? null, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      return resolve({ data: matches(), error: null });
    },
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) => (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => null }));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: (table: string) => queryBuilder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  },
}));

const routes = await import("../../routes/sessions-live-approvals");

const WS = "ws-1";
const SESSION = "session-1";

function request(path: string, body: unknown, params: Record<string, string> = {}) {
  const req = new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
  return Object.assign(req, { params: { id: WS, sessionId: SESSION, ...params } }) as never;
}

beforeEach(() => {
  rpcCalls = [];
  rpcResult = { data: null, error: null };
  tables = {
    workspaces: [{ id: WS, live_sessions_enabled: true }],
    sessions: [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", host_machine_id: "host-1", status: "live", last_seq: 0 }],
    session_inputs: [],
    users: [{ id: "user-2", display_name: "Priya", email: "p@example.test" }],
  };
});

describe("deciding a permission request", () => {
  const decide = (body: unknown, requestId = "r1") => routes.DECISION(request("/x", body, { requestId }));

  it("records the decision with the author taken from the caller", async () => {
    rpcResult = { data: { outcome: "created" }, error: null };
    const res = await decide({ decision: "allow", author_user_id: "attacker" });
    expect(res.status).toBe(201);
    expect(rpcCalls[0]!.args).toMatchObject({ p_author_user_id: "user-2", p_author_name: "Priya", p_request_id: "r1", p_decision: "allow" });
  });

  it("tells a late decider who decided first", async () => {
    rpcResult = { data: { outcome: "already_decided", by_name: "Dev", decision: "deny" }, error: null };
    const res = await decide({ decision: "allow" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_decided", by_name: "Dev", decision: "deny" });
  });

  it("tells a late decider the request ended another way", async () => {
    rpcResult = { data: { outcome: "request_closed", reason: "answered_locally" }, error: null };
    const res = await decide({ decision: "allow" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "request_closed", reason: "answered_locally" });
  });

  it("maps an unknown request and an ended session", async () => {
    rpcResult = { data: null, error: { message: "request_not_found" } };
    expect((await decide({ decision: "allow" })).status).toBe(404);
    rpcResult = { data: null, error: { message: "session_ended" } };
    expect((await decide({ decision: "allow" })).status).toBe(409);
  });

  it("rejects a bad decision or request id before any database call", async () => {
    expect((await decide({ decision: "maybe" })).status).toBe(400);
    expect((await decide({ decision: "allow" }, "../x")).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe("Stop", () => {
  it("queues one stop for any member and ignores a second while one waits", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else" }];
    const first = await routes.STOP(request("/x", {}));
    expect(first.status).toBe(201);
    expect(rpcCalls[0]!.args).toMatchObject({ p_kind: "stop", p_author_user_id: "user-2" });

    tables.session_inputs = [{ session_id: SESSION, workspace_id: WS, kind: "stop", state: "queued" }];
    const second = await routes.STOP(request("/x", {}));
    expect(await second.json()).toEqual({ ok: true, already_requested: true });
    expect(rpcCalls.length).toBe(1);
  });
});

describe("host events", () => {
  const event = { sourceId: "perm:r1", kind: "permission_request", payload: { requestId: "r1" } };

  it("appends permission events from the session's host", async () => {
    rpcResult = { data: { last_seq: 4, inserted: 1 }, error: null };
    const res = await routes.HOST_EVENTS(request("/x", { hostMachineId: "host-1", events: [event] }));
    expect(await res.json()).toEqual({ ok: true, last_seq: 4, inserted: 1 });
    expect(rpcCalls[0]!.args.p_events).toEqual([{ source_id: "perm:r1", kind: "permission_request", payload: { requestId: "r1" } }]);
  });

  it("refuses other event kinds, other users and other hosts", async () => {
    const bad = await routes.HOST_EVENTS(request("/x", { hostMachineId: "host-1", events: [{ ...event, kind: "user_message" }] }));
    expect(bad.status).toBe(400);

    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", host_machine_id: "host-1" }];
    expect((await routes.HOST_EVENTS(request("/x", { hostMachineId: "host-1", events: [event] }))).status).toBe(403);

    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", host_machine_id: "host-1" }];
    rpcResult = { data: null, error: { message: "foreign_host" } };
    expect((await routes.HOST_EVENTS(request("/x", { hostMachineId: "host-9", events: [event] }))).status).toBe(403);
  });
});
