import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-2", accessToken: "token-2" };
let accessResult: Response | null = null;

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcError: { message: string } | null = null;
let updates: Array<{ table: string; payload: Row; eqs: [string, unknown][] }> = [];

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const gts: [string, number][] = [];
  const ltes: [string, number][] = [];
  const nulls: string[] = [];
  let updatePayload: Row | undefined;

  const matches = () =>
    (tables[table] ?? []).filter(
      (row) =>
        eqs.every(([col, v]) => row[col] === v) &&
        ins.every(([col, vs]) => vs.includes(row[col])) &&
        gts.every(([col, v]) => (row[col] as number) > v) &&
        ltes.every(([col, v]) => (row[col] as number) <= v) &&
        nulls.every((col) => row[col] == null),
    );

  const builder = {
    select: () => builder,
    update: (payload: Row) => {
      updatePayload = payload;
      return builder;
    },
    eq: (col: string, value: unknown) => (eqs.push([col, value]), builder),
    in: (col: string, values: unknown[]) => (ins.push([col, values]), builder),
    gt: (col: string, value: number) => (gts.push([col, value]), builder),
    lte: (col: string, value: number) => (ltes.push([col, value]), builder),
    is: (col: string) => (nulls.push(col), builder),
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      return { data: matches()[0] ?? null, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      if (updatePayload) {
        updates.push({ table, payload: updatePayload, eqs });
        const hit = matches();
        return resolve({ data: hit, error: null });
      }
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
      if (rpcError) return { data: null, error: rpcError };
      if (fn === "create_session_input") {
        return { data: { id: "input-new", author_user_id: args.p_author_user_id, author_name: args.p_author_name, kind: "message", payload: args.p_payload, state: "queued", reason: null, created_at: "t", updated_at: "t" }, error: null };
      }
      return { data: true, error: null };
    },
  },
}));

const routes = await import("../../routes/sessions-live-inputs");

const WS = "ws-1";
const SESSION = "session-1";

function request(method: string, path: string, body?: unknown, params: Record<string, string> = { id: WS, sessionId: SESSION }) {
  const req = new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return Object.assign(req, { params }) as never;
}

beforeEach(() => {
  accessResult = null;
  rpcCalls = [];
  rpcError = null;
  updates = [];
  tables = {
    sessions: [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", status: "live", host_machine_id: "host-1", last_seq: 0 }],
    session_inputs: [],
    session_events: [],
    users: [{ id: "user-2", display_name: "Priya", email: "p@example.test" }],
  };
});

describe("sending a message", () => {
  it("creates a queued input with the author from the caller", async () => {
    const res = await routes.INPUTS_CREATE(request("POST", "/x", { text: "please add tests", author_user_id: "attacker", authorName: "Dev" }));
    expect(res.status).toBe(201);
    const call = rpcCalls[0]!;
    expect(call.fn).toBe("create_session_input");
    expect(call.args.p_author_user_id).toBe("user-2");
    expect(call.args.p_author_name).toBe("Priya");
    expect(call.args.p_payload).toEqual({ text: "please add tests" });
  });

  it("strips control characters that could end a paste early", async () => {
    await routes.INPUTS_CREATE(request("POST", "/x", { text: "hi\u001b[201~ rm -rf\u0000 there\r\nline two" }));
    expect((rpcCalls[0]!.args.p_payload as { text: string }).text).toBe("hi[201~ rm -rf there\nline two");
  });

  it("rejects an empty or too long message", async () => {
    expect((await routes.INPUTS_CREATE(request("POST", "/x", { text: " \n\u0007 " }))).status).toBe(400);
    expect((await routes.INPUTS_CREATE(request("POST", "/x", { text: "a".repeat(10_001) }))).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("maps a full queue and an ended session to clear errors", async () => {
    rpcError = { message: "queue_full" };
    const full = await routes.INPUTS_CREATE(request("POST", "/x", { text: "hi" }));
    expect(full.status).toBe(429);
    rpcError = { message: "session_ended" };
    const ended = await routes.INPUTS_CREATE(request("POST", "/x", { text: "hi" }));
    expect(ended.status).toBe(409);
  });

  it("lets any workspace member send, not only the owner", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", status: "live", host_machine_id: "host-1", last_seq: 0 }];
    const res = await routes.INPUTS_CREATE(request("POST", "/x", { text: "hello" }));
    expect(res.status).toBe(201);
  });

  it("rejects a non-member", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await routes.INPUTS_CREATE(request("POST", "/x", { text: "hi" }))).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });
});

describe("host routes", () => {
  const input = { id: "i1", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", author_name: "Dev", author_user_id: "u9", payload: { text: "run tests" }, created_at: "t", updated_at: "t" };

  it("gives the host the exact text to paste, with the author in front", async () => {
    tables.session_inputs = [input];
    const res = await routes.INPUTS_PENDING(request("GET", "/x?hostMachineId=host-1"));
    const body = (await res.json()) as { inputs: Array<{ delivered_text: string }> };
    expect(body.inputs[0]!.delivered_text).toBe("[Dev via Draft] run tests");
  });

  it("refuses pending inputs to a user who does not own the session and to another host", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", status: "live", host_machine_id: "host-1", last_seq: 0 }];
    expect((await routes.INPUTS_PENDING(request("GET", "/x?hostMachineId=host-1"))).status).toBe(403);
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", status: "live", host_machine_id: "host-1", last_seq: 0 }];
    expect((await routes.INPUTS_PENDING(request("GET", "/x?hostMachineId=host-9"))).status).toBe(403);
  });

  const stateRequest = (body: unknown) => request("POST", "/x", body, { id: WS, sessionId: SESSION, inputId: "i1" });

  it("moves an input to delivering", async () => {
    const res = await routes.INPUT_STATE(stateRequest({ hostMachineId: "host-1", from: ["queued"], to: "delivering" }));
    expect(await res.json()).toEqual({ ok: true, changed: true });
    expect(rpcCalls[0]!.args).toMatchObject({ p_input_id: "i1", p_from: ["queued"], p_to: "delivering" });
  });

  it("the host cannot mark a message consumed, but can mark a stop or a decision", async () => {
    tables.session_inputs = [input, { ...input, id: "i2", kind: "stop" }];
    const message = await routes.INPUT_STATE(stateRequest({ hostMachineId: "host-1", from: ["delivering"], to: "consumed" }));
    expect(message.status).toBe(400);
    expect(rpcCalls).toEqual([]);
    const stop = await routes.INPUT_STATE(request("POST", "/x", { hostMachineId: "host-1", from: ["delivering"], to: "consumed" }, { id: WS, sessionId: SESSION, inputId: "i2" }));
    expect(stop.status).toBe(200);
    expect(rpcCalls[0]!.args).toMatchObject({ p_input_id: "i2", p_to: "consumed" });
  });

  it("gives the host messages, stops and decisions in one list when it asks for all, and only messages by default", async () => {
    tables.session_inputs = [
      input,
      { ...input, id: "i2", kind: "stop" },
      { ...input, id: "i3", kind: "permission_decision", payload: { requestId: "r1", decision: "allow" } },
      { ...input, id: "i4", kind: "stop", state: "consumed" },
    ];
    type Pending = { inputs: Array<{ id: string; kind: string; delivered_text?: string; payload: unknown }> };
    const all = (await (await routes.INPUTS_PENDING(request("GET", "/x?hostMachineId=host-1&kinds=all"))).json()) as Pending;
    expect(all.inputs.map((i) => [i.id, i.kind])).toEqual([["i1", "message"], ["i2", "stop"], ["i3", "permission_decision"]]);
    expect(all.inputs[0]!.delivered_text).toBe("[Dev via Draft] run tests");
    expect(all.inputs[1]!.delivered_text).toBeUndefined();
    expect(all.inputs[2]!.payload).toEqual({ requestId: "r1", decision: "allow" });

    const messagesOnly = (await (await routes.INPUTS_PENDING(request("GET", "/x?hostMachineId=host-1"))).json()) as Pending;
    expect(messagesOnly.inputs.map((i) => i.id)).toEqual(["i1"]);
  });

  it("refuses a state change from another host", async () => {
    const res = await routes.INPUT_STATE(stateRequest({ hostMachineId: "host-9", from: ["queued"], to: "delivering" }));
    expect(res.status).toBe(403);
  });
});

describe("resend and dismiss", () => {
  const failed = { id: "i1", session_id: SESSION, workspace_id: WS, kind: "message", state: "uncertain", author_user_id: "user-2", author_name: "Priya", payload: { text: "try again" }, created_at: "t", updated_at: "t" };
  const actionRequest = (action: string) => request("POST", "/x", { action }, { id: WS, sessionId: SESSION, inputId: "i1" });

  it("resend dismisses the old input and queues a new one with the same text", async () => {
    tables.session_inputs = [failed];
    const res = await routes.INPUT_ACTION(actionRequest("resend"));
    expect(res.status).toBe(201);
    expect(updates[0]!.payload.dismissed_at).toBeString();
    expect(rpcCalls[0]!.args.p_payload).toEqual({ text: "try again" });
  });

  it("only the author can resend, and only an unfinished input", async () => {
    tables.session_inputs = [{ ...failed, author_user_id: "user-9" }];
    expect((await routes.INPUT_ACTION(actionRequest("resend"))).status).toBe(409);
    tables.session_inputs = [{ ...failed, state: "consumed" }];
    expect((await routes.INPUT_ACTION(actionRequest("resend"))).status).toBe(409);
    expect(rpcCalls).toEqual([]);
  });

  it("dismiss queues nothing", async () => {
    tables.session_inputs = [failed];
    const res = await routes.INPUT_ACTION(actionRequest("dismiss"));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
  });
});

describe("steer", () => {
  const queued = { id: "i1", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", author_user_id: "user-2", author_name: "Priya", payload: { text: "also check lint" }, created_at: "t", updated_at: "t" };
  const steer = () => routes.INPUT_ACTION(request("POST", "/x", { action: "steer" }, { id: WS, sessionId: SESSION, inputId: "i1" }));

  it("marks the author's own queued message to join the running turn, for a harness that can steer", async () => {
    tables.sessions[0]!.harness = "codex";
    tables.session_inputs = [queued];
    expect((await steer()).status).toBe(200);
    expect(updates[0]!.payload).toEqual({ payload: { text: "also check lint", steer: true } });
  });

  it("refuses a harness that cannot steer, another person's message and a message that is not queued", async () => {
    tables.sessions[0]!.harness = "claude";
    tables.session_inputs = [queued];
    expect((await steer()).status).toBe(409);
    tables.sessions[0]!.harness = "codex";
    tables.session_inputs = [{ ...queued, author_user_id: "user-9" }];
    expect((await steer()).status).toBe(409);
    tables.session_inputs = [{ ...queued, state: "delivering" }];
    expect((await steer()).status).toBe(409);
    expect(updates).toEqual([]);
  });
});

describe("matching consumed inputs", () => {
  const waiting = (id: string, authorName: string, text: string, state = "delivering") => ({ id, session_id: SESSION, workspace_id: WS, kind: "message", state, author_name: authorName, payload: { text }, created_at: id });
  const turn = (seq: number, text: string, extra: Row = {}) => ({ session_id: SESSION, workspace_id: WS, kind: "user_message", seq, payload: { text, ...extra } });

  it("marks the input whose delivered text appears as a new user turn", async () => {
    tables.session_inputs = [waiting("a", "Dev", "run tests"), waiting("b", "Priya", "ship it")];
    tables.session_events = [turn(5, "[Priya via Draft] ship it")];
    await routes.matchConsumedInputs(WS, SESSION, 4, 5);
    expect(rpcCalls.map((c) => [c.args.p_input_id, c.args.p_to, c.args.p_consumed_seq])).toEqual([["b", "consumed", 5]]);
  });

  it("matches multi-line text when whitespace differs", async () => {
    tables.session_inputs = [waiting("a", "Dev", "line one\n\nline two  ")];
    tables.session_events = [turn(3, "[Dev via Draft] line one\nline two")];
    await routes.matchConsumedInputs(WS, SESSION, 2, 3);
    expect(rpcCalls.length).toBe(1);
  });

  it("two identical messages are consumed one turn at a time, oldest first", async () => {
    tables.session_inputs = [waiting("a", "Dev", "go"), waiting("b", "Dev", "go")];
    tables.session_events = [turn(2, "[Dev via Draft] go")];
    await routes.matchConsumedInputs(WS, SESSION, 1, 2);
    expect(rpcCalls.map((c) => c.args.p_input_id)).toEqual(["a"]);
  });

  it("an uncertain input is consumed when its turn shows up late", async () => {
    tables.session_inputs = [waiting("a", "Dev", "go", "uncertain")];
    tables.session_events = [turn(2, "[Dev via Draft] go")];
    await routes.matchConsumedInputs(WS, SESSION, 1, 2);
    expect(rpcCalls.length).toBe(1);
  });

  it("a dismissed input is not matched, so a resend takes the turn", async () => {
    tables.session_inputs = [{ ...waiting("old", "Dev", "go", "uncertain"), dismissed_at: "t" }, waiting("new", "Dev", "go")];
    tables.session_events = [turn(2, "[Dev via Draft] go")];
    await routes.matchConsumedInputs(WS, SESSION, 1, 2);
    expect(rpcCalls.map((c) => c.args.p_input_id)).toEqual(["new"]);
  });

  it("ignores typed turns, sub-agent turns and old turns", async () => {
    tables.session_inputs = [waiting("a", "Dev", "go")];
    tables.session_events = [turn(2, "go"), turn(3, "[Dev via Draft] go", { agent_id: "x" }), turn(1, "[Dev via Draft] go")];
    await routes.matchConsumedInputs(WS, SESSION, 1, 3);
    expect(rpcCalls).toEqual([]);
  });
});
