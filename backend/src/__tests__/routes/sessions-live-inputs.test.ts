import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/run-spec";
import { createAgentRunToken } from "../../metaharness/runs/run-token";
import type { CloudSessionDeps } from "../../cloud-sessions/launch";
import type { SandboxProvider } from "../../metaharness/sandbox/providers";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

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
        const author = tables.users!.find((u) => u.id === args.p_author_user_id);
        return { data: { id: "input-new", author_user_id: args.p_author_user_id, author_name: args.p_author_name ?? author?.display_name ?? author?.email ?? "A teammate", kind: "message", payload: args.p_payload, state: "queued", reason: null, created_at: "t", updated_at: "t" }, error: null };
      }
      if (fn === "host_transition_session_input") {
        const session = tables.sessions!.find((r) => r.id === args.p_session_id && r.workspace_id === args.p_workspace_id);
        const fail = (message: string) => ({ data: null, error: { message } });
        if (!session) return fail("session_not_found");
        if (session.owner_user_id !== args.p_owner_user_id) return fail("not_session_owner");
        if (session.host_id !== args.p_host_id) return fail("foreign_host");
        const input = tables.session_inputs!.find((r) => r.id === args.p_input_id);
        if (args.p_to === "consumed" && (!input || input.kind === "message")) return fail("invalid_state");
      }
      return { data: true, error: null };
    },
  },
}));

// A sleeping cloud session wakes through the real wake, on the deps a test sets. No test sets them unless it needs a wake.
let makeWakeDeps: (() => CloudSessionDeps) | null = null;
mock.module("../../cloud-sessions/deps", () => ({
  productionStartDeps: () => {
    if (!makeWakeDeps) throw new Error("No sandbox deps are set for this test");
    return makeWakeDeps();
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
    sessions: [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", status: "live", host_id: "host-1", last_seq: 0 }],
    session_inputs: [],
    session_events: [],
    users: [{ id: "user-2", display_name: "Priya", email: "p@example.test" }],
  };
});

describe("a message to a sleeping cloud session", () => {
  const WAKE_WS = "11111111-1111-4111-8111-111111111111";
  const WAKE_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const WAKE_OWNER = "66666666-6666-4666-8666-666666666666";
  const VERSION = "44444444-4444-4444-8444-444444444444";
  const PREVIOUS_RUN = "10000000-0000-4000-8000-0000000000aa";
  let wake: FakeDb;
  let startError: Error | null = null;

  const wakeRequest = (body: unknown) => request("POST", "/x", body, { id: WAKE_WS, sessionId: WAKE_SESSION });

  /** The wake's own database: its session row, the last run to wake from, and the claim the database would run. */
  function wakeDb(): FakeDb {
    const db = fakeDb({
      workspaces: [{ id: WAKE_WS, timezone: "UTC", current_context_version_id: VERSION }],
      sessions: [
        {
          id: WAKE_SESSION,
          workspace_id: WAKE_WS,
          owner_user_id: WAKE_OWNER,
          execution_target: "sandbox",
          adapter_id: "claude-terminal",
          harness: "claude",
          status: "sleeping",
          model: "haiku",
          reasoning_effort: null,
          git_remote: "https://github.com/acme/app.git",
          seed: { kind: "repo", branch: "main" },
          sandbox_volume: { provider: "fly", id: "vol-1", region: "iad" },
          host_id: `cloud:${WAKE_SESSION}`,
          deleted_at: null,
        },
      ],
      agent_runs: [
        {
          id: PREVIOUS_RUN,
          workspace_id: WAKE_WS,
          session_id: WAKE_SESSION,
          kind: "interactive",
          trigger: { type: "manual", requestedBy: WAKE_OWNER },
          on_behalf_of_user_id: null,
          execution: { target: { type: "sandbox" }, adapterId: "claude-terminal" }, toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] }, computer: { type: "sandbox", profileId: "default", workingDirectory: "/data/workspace", network: "restricted" }, continuation: null,
          harness: "claude",
          model: "haiku",
          reasoning_effort: null,
          instructions: "",
          base_context_version_id: VERSION,
          permissions: [],
          output: { type: "text" },
          status: "succeeded",
          sandbox_machine_id: null,
          created_at: "2026-11-18T09:00:00.000Z",
        },
      ],
      session_inputs: [],
      errors: [],
    });
    db.rpcs.claim_cloud_session_wake = (args) => {
      const row = db.tables.sessions!.find((s) => s.id === args.p_session_id && s.status === "sleeping");
      if (!row) return { data: false };
      row.status = "starting";
      return { data: true };
    };
    return db;
  }

  const provider = (): SandboxProvider => ({
    async create(spec) {
      return { provider: "fly", machine: "machine-new", volume: spec.volume && "existing" in spec.volume ? spec.volume.existing : null };
    },
    async start() {
      if (startError) throw startError;
    },
    async stop() {},
    async destroy() {},
    async destroyMachine() {},
    async status() {
      return "missing";
    },
  });

  const wakeDeps = (): CloudSessionDeps => ({
    client: fakeClient(wake),
    provider: provider(),
    config: {
      callbackUrl: "https://api.draft.test/sandbox/callback",
      callbackSecret: "callback-test-secret",
      supabaseUrl: "https://project.supabase.co",
      provider: { kind: "fly", apiToken: "fly-token", appName: "draft-sandbox", image: `registry.fly.io/draft-sandbox@sha256:${"a".repeat(64)}`, region: "iad" },
    },
    tokenSecret: "wake-route-test-secret",
    resolveCredential: async () => ({ credentialId: "cred-1", secret: "sk-ant-test" }),
  });

  beforeEach(() => {
    wake = wakeDb();
    startError = null;
    makeWakeDeps = wakeDeps;
    tables.sessions = [{ id: WAKE_SESSION, workspace_id: WAKE_WS, owner_user_id: WAKE_OWNER, status: "sleeping", execution_target: "sandbox", harness: "claude", host_id: `cloud:${WAKE_SESSION}`, last_seq: 0 }];
  });
  afterEach(() => {
    makeWakeDeps = null;
  });

  it("wakes the session, so the message goes to a new run", async () => {
    const res = await routes.INPUTS_CREATE(wakeRequest({ text: "pick up the tests" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, input: { text: "pick up the tests" } });
    expect(wake.rpcCalls.map((call) => call.name)).toContain("claim_cloud_session_wake");
    expect(wake.tables.sessions![0]).toMatchObject({ status: "starting" });
    expect(wake.tables.agent_runs!.filter((row) => row.status === "running")).toHaveLength(1);
  });

  it("still sends the message when the wake fails, and records why", async () => {
    startError = new Error("machine did not boot");
    const res = await routes.INPUTS_CREATE(wakeRequest({ text: "hello" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, input: { text: "hello" } });
    expect(wake.tables.sessions![0]).toMatchObject({ status: "sleeping" });
    expect(wake.tables.errors!.map((row) => (row.detail_json as { code?: string }).code)).toEqual(["sandbox_start_failed"]);
  });

  it("returns the message as the wake left it, so a session that ends shows the message failed", async () => {
    wake.tables.agent_runs = [1, 2, 3].map((n) => ({ id: `run-${n}`, workspace_id: WAKE_WS, session_id: WAKE_SESSION, status: "failed", created_at: `2026-11-18T0${n}:00:00.000Z` }));
    tables.session_inputs = [
      { id: "input-new", session_id: WAKE_SESSION, workspace_id: WAKE_WS, author_user_id: "user-2", author_name: "Priya", kind: "message", payload: { text: "hello" }, state: "failed", reason: "session_ended", created_at: "t", updated_at: "t" },
    ];
    const res = await routes.INPUTS_CREATE(wakeRequest({ text: "hello" }));

    expect(((await res.json()) as { input: { state: string } }).input.state).toBe("failed");
    expect(wake.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "start_failed" });
  });

  it("still sends the message when the wake cannot be set up, and logs the failure", async () => {
    makeWakeDeps = () => {
      throw new Error("SANDBOX_IMAGE is missing");
    };
    const logged: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
    try {
      const res = await routes.INPUTS_CREATE(wakeRequest({ text: "hello" }));
      expect(res.status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(logged)).toContain("wake_failed");
  });

  it("does not wake a session that is live", async () => {
    tables.sessions = [{ ...tables.sessions![0]!, status: "live" }];
    const res = await routes.INPUTS_CREATE(wakeRequest({ text: "hello" }));

    expect(res.status).toBe(201);
    expect(wake.rpcCalls).toEqual([]);
  });
});

describe("sending a message", () => {
  it("creates a queued input with the author from the caller", async () => {
    const res = await routes.INPUTS_CREATE(request("POST", "/x", { text: "please add tests", author_user_id: "attacker", authorName: "Dev" }));
    expect(res.status).toBe(201);
    const call = rpcCalls[0]!;
    expect(call.fn).toBe("create_session_input");
    expect(call.args.p_author_user_id).toBe("user-2");
    expect(call.args.p_author_name).toBeNull();
    expect(((await res.json()) as { input: { author_name: string } }).input.author_name).toBe("Priya");
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
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", status: "live", host_id: "host-1", last_seq: 0 }];
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
    const res = await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-1"));
    const body = (await res.json()) as { inputs: Array<{ delivered_text: string }> };
    expect(body.inputs[0]!.delivered_text).toBe("[Dev via Draft] run tests");
  });

  it("puts the start of the input id in the tag", async () => {
    tables.session_inputs = [{ ...input, id: "ab12cd34-0000-4000-8000-000000000000" }];
    const body = (await (await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-1"))).json()) as { inputs: Array<{ delivered_text: string }> };
    expect(body.inputs[0]!.delivered_text).toBe("[Dev via Draft #ab12cd34] run tests");
  });

  it("refuses pending inputs to a user who does not own the session and to another host", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", status: "live", host_id: "host-1", last_seq: 0 }];
    expect((await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-1"))).status).toBe(403);
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "user-2", status: "live", host_id: "host-1", last_seq: 0 }];
    expect((await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-9"))).status).toBe(403);
  });

  const stateRequest = (body: unknown) => request("POST", "/x", body, { id: WS, sessionId: SESSION, inputId: "i1" });

  it("moves an input to delivering", async () => {
    const res = await routes.INPUT_STATE(stateRequest({ hostId: "host-1", from: ["queued"], to: "delivering" }));
    expect(await res.json()).toEqual({ ok: true, changed: true });
    expect(rpcCalls[0]!.args).toMatchObject({ p_input_id: "i1", p_from: ["queued"], p_to: "delivering" });
  });

  it("the host cannot mark a message consumed, but can mark a stop or a decision", async () => {
    tables.session_inputs = [input, { ...input, id: "i2", kind: "stop" }];
    const message = await routes.INPUT_STATE(stateRequest({ hostId: "host-1", from: ["delivering"], to: "consumed" }));
    expect(message.status).toBe(400);
    rpcCalls = [];
    const stop = await routes.INPUT_STATE(request("POST", "/x", { hostId: "host-1", from: ["delivering"], to: "consumed" }, { id: WS, sessionId: SESSION, inputId: "i2" }));
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
    const all = (await (await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-1&kinds=all"))).json()) as Pending;
    expect(all.inputs.map((i) => [i.id, i.kind])).toEqual([["i1", "message"], ["i2", "stop"], ["i3", "permission_decision"]]);
    expect(all.inputs[0]!.delivered_text).toBe("[Dev via Draft] run tests");
    expect(all.inputs[1]!.delivered_text).toBeUndefined();
    expect(all.inputs[2]!.payload).toEqual({ requestId: "r1", decision: "allow" });

    const messagesOnly = (await (await routes.INPUTS_PENDING(request("GET", "/x?hostId=host-1"))).json()) as Pending;
    expect(messagesOnly.inputs.map((i) => i.id)).toEqual(["i1"]);
  });

  it("refuses a state change from a user who does not own the session", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "someone-else", status: "live", host_id: "host-1", last_seq: 0 }];
    const res = await routes.INPUT_STATE(stateRequest({ hostId: "host-1", from: ["queued"], to: "delivering" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_session_owner" });
  });

  it("refuses a state change from another host", async () => {
    const res = await routes.INPUT_STATE(stateRequest({ hostId: "host-9", from: ["queued"], to: "delivering" }));
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

describe("cancel", () => {
  const queued = { id: "i1", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", author_user_id: "user-2", author_name: "Priya", payload: { text: "hello" }, created_at: "t", updated_at: "t" };
  const cancel = () => routes.INPUT_ACTION(request("POST", "/x", { action: "cancel" }, { id: WS, sessionId: SESSION, inputId: "i1" }));

  it("withdraws the author's own queued message", async () => {
    tables.session_inputs = [queued];
    expect((await cancel()).status).toBe(200);
    expect(rpcCalls).toEqual([{ fn: "transition_session_input", args: { p_input_id: "i1", p_session_id: SESSION, p_from: ["queued"], p_to: "cancelled", p_reason: null, p_consumed_seq: null } }]);
  });

  it("refuses another person's message and one the host already took", async () => {
    tables.session_inputs = [{ ...queued, author_user_id: "user-9" }];
    expect((await cancel()).status).toBe(409);
    tables.session_inputs = [{ ...queued, state: "delivering" }];
    expect((await cancel()).status).toBe(409);
    expect(rpcCalls).toEqual([]);
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

  describe("by the id in the tag", () => {
    const A = "aaaa1111-0000-4000-8000-000000000000";
    const B = "bbbb2222-0000-4000-8000-000000000000";

    it("links a turn whose text differs from the message, by its id", async () => {
      tables.session_inputs = [waiting(A, "Dev", "run tests")];
      tables.session_events = [turn(4, "[Dev via Draft #aaaa1111] run tests, edited by Claude Code")];
      await routes.matchConsumedInputs(WS, SESSION, 3, 4);
      expect(rpcCalls.map((c) => [c.args.p_input_id, c.args.p_consumed_seq])).toEqual([[A, 4]]);
    });

    it("gives two identical messages to the right inputs, whatever their order", async () => {
      tables.session_inputs = [waiting(A, "Dev", "go"), waiting(B, "Priya", "go")];
      tables.session_events = [turn(2, "[Priya via Draft #bbbb2222] go"), turn(3, "[Dev via Draft #aaaa1111] go")];
      await routes.matchConsumedInputs(WS, SESSION, 1, 3);
      expect(rpcCalls.map((c) => [c.args.p_input_id, c.args.p_consumed_seq])).toEqual([[B, 2], [A, 3]]);
    });

    it("links nothing for an unknown id or an input that is no longer waiting", async () => {
      tables.session_inputs = [waiting(A, "Dev", "go"), waiting(B, "Dev", "go", "consumed")];
      tables.session_events = [turn(2, "[Dev via Draft #cccc3333] go"), turn(3, "[Dev via Draft #bbbb2222] go")];
      await routes.matchConsumedInputs(WS, SESSION, 1, 3);
      expect(rpcCalls).toEqual([]);
    });

    it("still links an old turn with no id by its text", async () => {
      tables.session_inputs = [waiting(A, "Dev", "go")];
      tables.session_events = [turn(2, "[Dev via Draft] go")];
      await routes.matchConsumedInputs(WS, SESSION, 1, 2);
      expect(rpcCalls.map((c) => c.args.p_input_id)).toEqual([A]);
    });
  });

  describe("a merged turn with several tagged messages", () => {
    const A = "aaaa1111-0000-4000-8000-000000000000";
    const B = "bbbb2222-0000-4000-8000-000000000000";
    const merged = "[Dev via Draft #aaaa1111] run tests\n\n[Priya via Draft #bbbb2222] ship it";

    it("consumes every input in the turn with the same seq", async () => {
      tables.session_inputs = [waiting(A, "Dev", "run tests"), waiting(B, "Priya", "ship it")];
      tables.session_events = [turn(5, merged)];
      await routes.matchConsumedInputs(WS, SESSION, 4, 5);
      expect(rpcCalls.map((c) => [c.args.p_input_id, c.args.p_consumed_seq])).toEqual([[A, 5], [B, 5]]);
    });

    it("still consumes one input for a single tagged turn", async () => {
      tables.session_inputs = [waiting(A, "Dev", "run tests"), waiting(B, "Priya", "ship it")];
      tables.session_events = [turn(5, "[Dev via Draft #aaaa1111] run tests")];
      await routes.matchConsumedInputs(WS, SESSION, 4, 5);
      expect(rpcCalls.map((c) => [c.args.p_input_id, c.args.p_consumed_seq])).toEqual([[A, 5]]);
    });

    it("consumes nothing for a turn whose only tag is unknown", async () => {
      tables.session_inputs = [waiting(A, "Dev", "run tests")];
      tables.session_events = [turn(5, "[Dev via Draft #cccc3333] run tests")];
      await routes.matchConsumedInputs(WS, SESSION, 4, 5);
      expect(rpcCalls).toEqual([]);
    });

    it("skips a later tag that matches several waiting inputs", async () => {
      const A2 = "aaaa1111-1111-4000-8000-000000000000";
      tables.session_inputs = [waiting(A, "Dev", "run tests"), waiting(A2, "Dev", "lint"), waiting(B, "Priya", "ship it")];
      tables.session_events = [turn(5, "[Priya via Draft #bbbb2222] ship it\n\n[Dev via Draft #aaaa1111] run tests")];
      await routes.matchConsumedInputs(WS, SESSION, 4, 5);
      expect(rpcCalls.map((c) => c.args.p_input_id)).toEqual([B]);
    });
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

describe("cloud host requests", () => {
  const CLOUD_WS = "11111111-1111-4111-8111-111111111111";
  const RUN = "22222222-2222-4222-8222-222222222222";
  const CLOUD_HOST = `cloud:${SESSION}`;
  const SECRET = "live-inputs-cloud-test-secret";
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.SANDBOX_CALLBACK_SECRET;
    process.env.SANDBOX_CALLBACK_SECRET = SECRET;
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.SANDBOX_CALLBACK_SECRET;
    else process.env.SANDBOX_CALLBACK_SECRET = savedSecret;
  });

  const cloudRequest = (method: string, path: string, body?: unknown, params: Record<string, string> = { id: CLOUD_WS, sessionId: SESSION, inputId: "i1" }) =>
    Object.assign(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${createAgentRunToken({ runId: parseAgentRunId(RUN), workspaceId: parseWorkspaceId(CLOUD_WS), expiresAt: Date.now() + 60_000, nonce: "n", scope: "host" }, SECRET)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params },
    ) as never;

  beforeEach(() => {
    tables.sessions = [{ id: SESSION, workspace_id: CLOUD_WS, owner_user_id: "user-2", execution_target: "sandbox", status: "live", host_id: CLOUD_HOST, last_seq: 0 }];
    tables.agent_runs = [{ id: RUN, workspace_id: CLOUD_WS, kind: "interactive", status: "running", session_id: SESSION }];
    tables.session_inputs = [
      { id: "i1", session_id: SESSION, workspace_id: CLOUD_WS, kind: "message", state: "queued", author_user_id: "user-2", author_name: "Priya", payload: { text: "run tests" }, created_at: "t", updated_at: "t" },
    ];
  });

  it("gives its own host the waiting messages, and refuses another host", async () => {
    const res = await routes.INPUTS_PENDING(cloudRequest("GET", "/x", undefined, { id: CLOUD_WS, sessionId: SESSION }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inputs: Array<{ id: string }> }).inputs.map((i) => i.id)).toEqual(["i1"]);

    expect((await routes.INPUTS_PENDING(cloudRequest("GET", "/x?hostId=host-1", undefined, { id: CLOUD_WS, sessionId: SESSION }))).status).toBe(403);
  });

  it("moves an input as the session's owner, for its own host only", async () => {
    const ok = await routes.INPUT_STATE(cloudRequest("POST", "/x", { from: ["queued"], to: "delivering" }));
    expect(await ok.json()).toEqual({ ok: true, changed: true });
    expect(rpcCalls[0]).toMatchObject({
      fn: "host_transition_session_input",
      args: { p_input_id: "i1", p_owner_user_id: "user-2", p_host_id: CLOUD_HOST },
    });

    rpcCalls = [];
    const foreign = await routes.INPUT_STATE(cloudRequest("POST", "/x", { hostId: "host-1", from: ["queued"], to: "delivering" }));
    expect(foreign.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });
});
