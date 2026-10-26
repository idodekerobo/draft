import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let liveSessionsEnabled = true;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: { last_seq: 2, inserted: 2 }, error: null };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let inserted: Row[] = [];
let updates: Array<{ table: string; payload: Row }> = [];
let errorRows: Row[] = [];

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const gts: [string, number][] = [];
  const ins: [string, unknown[]][] = [];
  let insertPayload: Row | undefined;
  let updatePayload: Row | undefined;

  const matches = () =>
    (tables[table] ?? []).filter(
      (row) => eqs.every(([col, v]) => row[col] === v) && ins.every(([col, vs]) => vs.includes(row[col])) && gts.every(([col, v]) => (row[col] as number) > v),
    );

  const builder = {
    select: () => builder,
    insert: (payload: Row) => {
      if (table === "errors") {
        errorRows.push(payload);
        return Promise.resolve({ data: null, error: null });
      }
      insertPayload = payload;
      return builder;
    },
    update: (payload: Row) => {
      updatePayload = payload;
      updates.push({ table, payload });
      return builder;
    },
    eq: (col: string, value: unknown) => (eqs.push([col, value]), builder),
    in: (col: string, values: unknown[]) => (ins.push([col, values]), builder),
    neq: () => builder,
    is: () => builder,
    gt: (col: string, value: number) => (gts.push([col, value]), builder),
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      return { data: matches()[0] ?? null, error: null };
    },
    async single() {
      const row = { id: "new-session", status: "starting", last_seq: 0, ...insertPayload };
      inserted.push(row);
      return { data: row, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      if (updatePayload) return resolve({ data: null, error: null });
      return resolve({ data: matches(), error: null });
    },
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: (table: string) => queryBuilder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  },
}));

const routes = await import("../../routes/sessions-live");

const WS = "ws-1";
const SESSION = "session-1";

function session(overrides: Row = {}): Row {
  return {
    id: SESSION,
    workspace_id: WS,
    owner_user_id: "user-1",
    status: "live",
    title: null,
    native_session_id: null,
    host_machine_id: "host-1",
    last_seq: 0,
    ...overrides,
  };
}

function post(path: string, body: unknown, params: Record<string, string> = { id: WS, sessionId: SESSION }) {
  const req = new Request(`http://localhost${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return Object.assign(req, { params }) as never;
}

const userLine = (uuid: string, text: string) => ({
  file: "root.jsonl",
  offset: 0,
  raw: JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }),
});

beforeEach(() => {
  accessResult = null;
  liveSessionsEnabled = true;
  rpcResult = { data: { last_seq: 2, inserted: 2 }, error: null };
  rpcCalls.length = 0;
  inserted = [];
  updates = [];
  errorRows = [];
  tables = {
    workspaces: [{ id: WS, live_sessions_enabled: true }],
    sessions: [session()],
    session_events: [],
    users: [{ id: "user-1", display_name: "Maya", email: "maya@example.test" }],
  };
});

describe("live session routes", () => {
  it("rejects a caller who is not a workspace member", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const res = await routes.CREATE(post("/x", { hostMachineId: "host-1" }, { id: WS }));
    expect(res.status).toBe(403);
    expect(inserted).toEqual([]);
  });

  it("rejects every route when the workspace flag is off", async () => {
    tables.workspaces = [{ id: WS, live_sessions_enabled: false }];
    const res = await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "live_sessions_disabled" });
    expect(rpcCalls).toEqual([]);
  });

  it("takes the owner from the caller and never from the body", async () => {
    const res = await routes.CREATE(
      post("/x", { hostMachineId: "host-1", folderName: "app", nativeSessionId: "native-1", owner_user_id: "attacker", ownerUserId: "attacker" }, { id: WS }),
    );
    expect(res.status).toBe(201);
    expect(inserted[0].native_session_id).toBe("native-1");
    expect(inserted[0].owner_user_id).toBe("user-1");
    expect(inserted[0].workspace_id).toBe(WS);
  });

  it("requires a host machine id to create a session", async () => {
    const res = await routes.CREATE(post("/x", { folderName: "app" }, { id: WS }));
    expect(res.status).toBe(400);
  });

  it("refuses lines for a session the caller does not own", async () => {
    tables.sessions = [session({ owner_user_id: "someone-else" })];
    const res = await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_session_owner" });
    expect(rpcCalls).toEqual([]);
  });

  it("parses lines, appends the events and sets the title from the first prompt", async () => {
    const res = await routes.LINES(
      post("/x", { hostMachineId: "host-1", nativeSessionId: "native-1", lines: [userLine("u1", "Fix the login bug\nsecond line"), { file: "root.jsonl", offset: 5, raw: '{"type":"attachment"}' }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, last_seq: 2, inserted: 2 });
    expect(rpcCalls[0].fn).toBe("append_session_events");
    expect(rpcCalls[0].args.p_events).toEqual([
      { source_id: "u1", kind: "user_message", payload: { text: "Fix the login bug\nsecond line", timestamp: null } },
    ]);
    expect(updates.map((u) => u.payload)).toEqual([{ title: "Fix the login bug" }, { native_session_id: "native-1" }]);
  });

  it("does not call the database when no line has anything to show", async () => {
    const res = await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [{ file: "root.jsonl", offset: 0, raw: '{"type":"attachment"}' }] }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
  });

  it("maps a foreign host to 403 and an ended session to 409", async () => {
    rpcResult = { data: null, error: { message: "foreign_host" } };
    const foreign = await routes.LINES(post("/x", { hostMachineId: "host-2", lines: [userLine("u1", "hi")] }));
    expect(foreign.status).toBe(403);

    rpcResult = { data: null, error: { message: "session_ended" } };
    const ended = await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(ended.status).toBe(409);
  });

  it("records an error row and returns 500 for an unexpected append failure", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    const res = await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(res.status).toBe(500);
    await Bun.sleep(5);
    expect(errorRows[0]).toMatchObject({ workspace_id: WS, session_id: SESSION, operation: "session" });
  });

  it("rejects a malformed body, bad lines and an oversized body", async () => {
    expect((await routes.LINES(post("/x", "not json"))).status).toBe(400);
    expect((await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [{ raw: 1 }] }))).status).toBe(400);
    const big = post("/x", { hostMachineId: "host-1", lines: [userLine("u1", "x".repeat(5 * 1024 * 1024))] });
    expect((await routes.LINES(big)).status).toBe(413);
  });

  it("returns events above the requested seq with the session", async () => {
    tables.session_events = [
      { session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message" },
      { session_id: SESSION, workspace_id: WS, seq: 2, kind: "assistant_text" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=1"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { session: Row; events: Row[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    expect(body.session.owner_name).toBe("Maya");
  });

  it("ends a session only for its owner on its own host", async () => {
    expect((await routes.END(post("/x", { hostMachineId: "host-2" }))).status).toBe(403);
    const ok = await routes.END(post("/x", { hostMachineId: "host-1", reason: "user_exit" }));
    expect(ok.status).toBe(200);
    expect(updates.at(-1)?.payload).toMatchObject({ status: "ended", end_reason: "user_exit" });
  });
});
