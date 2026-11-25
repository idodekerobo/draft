import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/run-spec";
import { createAgentRunToken } from "../../metaharness/runs/run-token";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: { last_seq: 2, inserted: 2 }, error: null };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let storageObjects: Array<{ name: string }> = [];
const signedPaths: string[] = [];
const removedObjects: string[] = [];
const queriedTables: string[] = [];

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let inserted: Row[] = [];
let updates: Array<{ table: string; payload: Row }> = [];
let errorRows: Row[] = [];

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const gts: [string, number][] = [];
  const ins: [string, unknown[]][] = [];
  const ltes: [string, number][] = [];
  const nots: [string, unknown][] = [];
  const iss: [string, unknown][] = [];
  let insertPayload: Row | undefined;
  let updatePayload: Row | undefined;

  const matches = () =>
    (tables[table] ?? []).filter(
      (row) =>
        eqs.every(([col, v]) => row[col] === v) &&
        iss.every(([col, v]) => (row[col] ?? null) === v) &&
        ins.every(([col, vs]) => vs.includes(row[col])) &&
        gts.every(([col, v]) => (row[col] as number) > v) &&
        ltes.every(([col, v]) => (row[col] as number) <= v) &&
        nots.every(([col, v]) => (row[col] ?? null) !== v),
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
    is: (col: string, value: unknown) => (iss.push([col, value]), builder),
    gt: (col: string, value: number) => (gts.push([col, value]), builder),
    lte: (col: string, value: number) => (ltes.push([col, value]), builder),
    not: (col: string, _operator: string, value: unknown) => (nots.push([col, value]), builder),
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
    from: (table: string) => (queriedTables.push(table), queryBuilder(table)),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string) => {
          signedPaths.push(path);
          return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null };
        },
        list: async () => ({ data: storageObjects, error: null }),
        remove: async (keys: string[]) => {
          removedObjects.push(...keys);
          return { data: keys, error: null };
        },
      }),
    },
  },
}));

const routes = await import("../../routes/sessions-live");
const failures = await import("../../routes/errors");

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
    host_id: "host-1",
    harness: "claude",
    last_seq: 0,
    ...overrides,
  };
}

function post(path: string, body: unknown, params: Record<string, string> = { id: WS, sessionId: SESSION }) {
  const req = new Request(`http://localhost${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return Object.assign(req, { params }) as never;
}

const userLine = (uuid: string, text: string) => ({
  stream: "root.jsonl",
  position: 0,
  raw: JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }),
});

beforeEach(() => {
  accessResult = null;
  rpcResult = { data: { last_seq: 2, inserted: 2 }, error: null };
  rpcCalls.length = 0;
  storageObjects = [];
  signedPaths.length = 0;
  removedObjects.length = 0;
  queriedTables.length = 0;
  inserted = [];
  updates = [];
  errorRows = [];
  tables = {
    sessions: [session()],
    session_events: [],
    users: [{ id: "user-1", display_name: "Maya", email: "maya@example.test" }],
  };
});

describe("live session routes", () => {
  it("rejects a caller who is not a workspace member", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const res = await routes.CREATE(post("/x", { hostId: "host-1" }, { id: WS }));
    expect(res.status).toBe(403);
    expect(inserted).toEqual([]);
  });

  it("takes the owner from the caller and never from the body", async () => {
    const res = await routes.CREATE(
      post("/x", { hostId: "host-1", folderName: "app", nativeSessionId: "native-1", owner_user_id: "attacker", ownerUserId: "attacker" }, { id: WS }),
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

  it("creates a local session when the body says runtime local", async () => {
    const res = await routes.CREATE(post("/x", { runtime: "local", hostId: "host-1" }, { id: WS }));
    expect(res.status).toBe(201);
    expect(inserted.at(-1)).toMatchObject({ host_id: "host-1", workspace_id: WS });
  });

  it("refuses an unknown runtime and an invalid cloud body before it writes anything", async () => {
    const sessionsBefore = tables.sessions!.length;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ runtime: "gcp", hostId: "host-1" }, "unknown_runtime"],
      [{ runtime: "cloud", harness: "codex", seed: { kind: "repo", gitRemote: "https://github.com/acme/app", branch: "main" } }, "harness_not_supported"],
      [{ runtime: "cloud", seed: { kind: "repo", gitRemote: "http://github.com/acme/app", branch: "main" } }, "invalid_seed"],
      [{ runtime: "cloud", seed: { kind: "snapshot", storageKey: `${WS}/snap.tgz` } }, "invalid_seed"],
    ];
    for (const [body, error] of cases) {
      const res = await routes.CREATE(post("/x", body, { id: WS }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    expect(inserted).toEqual([]);
    expect(tables.sessions).toHaveLength(sessionsBefore);
  });

  it("refuses lines for a session the caller does not own", async () => {
    tables.sessions = [session({ owner_user_id: "someone-else" })];
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_session_owner" });
    expect(rpcCalls).toEqual([]);
  });

  it("does not match sent messages for a batch with no user turn", async () => {
    tables.session_inputs = [{ id: "w1", session_id: SESSION, workspace_id: WS, kind: "message", state: "delivering", payload: { text: "Fix the login bug" }, author_name: "Maya", created_at: "t" }];
    const assistantLine = { stream: "root.jsonl", position: 1, raw: JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }) };
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [assistantLine] }));
    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["append_session_events"]);
    expect(queriedTables).not.toContain("session_inputs");
  });

  it("matches a sent message when the batch holds a user turn", async () => {
    tables.session_inputs = [{ id: "w1", session_id: SESSION, workspace_id: WS, kind: "message", state: "delivering", payload: { text: "Fix the login bug" }, author_name: "Maya", created_at: "t" }];
    tables.session_events = [{ session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message", payload: { text: "[Maya via Draft] Fix the login bug" } }];
    await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "[Maya via Draft] Fix the login bug")] }));
    expect(rpcCalls.map((c) => c.fn)).toContain("transition_session_input");
  });

  it("refuses lines for a session whose harness this build does not know, and appends nothing", async () => {
    tables.sessions = [session({ harness: "future" })];
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "hello")] }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_agent");
    expect(rpcCalls).toEqual([]);
  });

  it("leaves the author tag of a Draft message out of the title", async () => {
    await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "[Maya via Draft] hello there")] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "hello there" }]);
  });

  it("parses lines, appends the events and sets the title from the first prompt", async () => {
    const res = await routes.LINES(
      post("/x", { hostId: "host-1", nativeSessionId: "native-1", lines: [userLine("u1", "Fix the login bug\nsecond line"), { stream: "root.jsonl", position: 5, raw: '{"type":"attachment"}' }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, last_seq: 2, inserted: 2 });
    expect(rpcCalls[0].fn).toBe("append_session_events");
    expect(rpcCalls[0].args.p_events).toEqual([
      { source_id: "u1", kind: "user_message", payload: { text: "Fix the login bug\nsecond line", timestamp: null } },
    ]);
    expect(updates.map((u) => u.payload)).toEqual([{ title: "Fix the login bug" }, { native_session_id: "native-1" }]);
  });

  it("replaces the first-prompt title with Claude Code's ai-title, and a rename beats it", async () => {
    tables.sessions = [session({ title: "Fix the login bug" })];
    const aiLine = { stream: "root.jsonl", position: 9, raw: '{"type":"ai-title","aiTitle":"Login bug fix"}' };
    await routes.LINES(post("/x", { hostId: "host-1", lines: [aiLine] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "Login bug fix" }]);

    updates = [];
    const renamed = { stream: "root.jsonl", position: 10, raw: '{"type":"custom-title","customTitle":"login-work"}' };
    await routes.LINES(post("/x", { hostId: "host-1", lines: [aiLine, renamed] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "login-work" }]);
  });

  it("does not call the database when no line has anything to show", async () => {
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [{ stream: "root.jsonl", position: 0, raw: '{"type":"attachment"}' }] }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
  });

  it("maps a foreign host to 403 and an ended session to 409", async () => {
    rpcResult = { data: null, error: { message: "foreign_host" } };
    const foreign = await routes.LINES(post("/x", { hostId: "host-2", lines: [userLine("u1", "hi")] }));
    expect(foreign.status).toBe(403);

    rpcResult = { data: null, error: { message: "session_ended" } };
    const ended = await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(ended.status).toBe(409);
  });

  it("records an error row and returns 500 for an unexpected append failure", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [userLine("u1", "hi")] }));
    expect(res.status).toBe(500);
    await Bun.sleep(5);
    expect(errorRows[0]).toMatchObject({ workspace_id: WS, session_id: SESSION, operation: "session" });
  });

  it("rejects a malformed body, bad lines and an oversized body", async () => {
    expect((await routes.LINES(post("/x", "not json"))).status).toBe(400);
    expect((await routes.LINES(post("/x", { hostId: "host-1", lines: [{ raw: 1 }] }))).status).toBe(400);
    const big = post("/x", { hostId: "host-1", lines: [userLine("u1", "x".repeat(5 * 1024 * 1024))] });
    expect((await routes.LINES(big)).status).toBe(413);
  });

  it("refuses lines in the retired file and offset names", async () => {
    const res = await routes.LINES(post("/x", { hostId: "host-1", lines: [{ file: "root.jsonl", offset: 0, raw: '{"type":"attachment"}' }] }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns events above the requested seq with the session", async () => {
    tables.session_events = [
      { session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message" },
      { session_id: SESSION, workspace_id: WS, seq: 2, kind: "assistant_text" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=1"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { session: Row; events: Row[]; inputs: Row[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    expect(body.session.owner_name).toBe("Maya");
    expect(body.session.mine).toBe(true);
    expect((body as unknown as { viewer: unknown }).viewer).toEqual({ id: "user-1", name: "Maya" });
    expect(body.inputs).toEqual([]);
  });

  it("names the sender of a user turn that came through Draft, and leaves the others null", async () => {
    tables.session_events = [
      { session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message" },
      { session_id: SESSION, workspace_id: WS, seq: 2, kind: "user_message" },
      { session_id: SESSION, workspace_id: WS, seq: 3, kind: "assistant_text" },
    ];
    tables.session_inputs = [
      { session_id: SESSION, workspace_id: WS, kind: "message", consumed_seq: 2, author_user_id: "user-9", state: "consumed" },
      { session_id: SESSION, workspace_id: WS, kind: "stop", consumed_seq: 1, author_user_id: "user-8", state: "consumed" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { events: Row[] };
    expect(body.events.map((e) => [e.seq, e.author_user_id])).toEqual([[1, null], [2, "user-9"], [3, undefined]]);
  });

  it("labels a turn and a waiting message with the sender's current name, not the one saved at send time", async () => {
    tables.users.push({ id: "user-9", display_name: "Priya Shah", email: "priya@example.test" });
    tables.session_events = [{ session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message" }];
    tables.session_inputs = [
      { session_id: SESSION, workspace_id: WS, kind: "message", consumed_seq: 1, author_user_id: "user-9", state: "consumed" },
      { id: "w", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", payload: { text: "hi" }, created_at: "t", updated_at: "t", author_user_id: "user-9", author_name: "priya@example.test" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { events: Row[]; inputs: Row[] };
    expect(body.events[0].author_name).toBe("Priya Shah");
    expect(body.inputs[0].author_name).toBe("Priya Shah");
  });

  it("links a session to the one it continues and to the one that replaced it", async () => {
    tables.sessions = [
      session({ id: "old", status: "ended", end_reason: "cleared", title: "Old chat", folder_name: "app" }),
      session({ id: SESSION, previous_session_id: "old" }),
    ];
    const get = async (sessionId: string) => {
      const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId } }) as never;
      return ((await (await routes.EVENTS(req)).json()) as { session: Row }).session;
    };
    expect((await get(SESSION)).previous_session).toMatchObject({ id: "old", title: "Old chat" });
    expect((await get("old")).next_session).toMatchObject({ id: SESSION });
    expect((await get(SESSION)).next_session).toBeNull();
  });

  it("returns the unfinished messages with the events, marking the caller's own", async () => {
    const waiting = { session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", payload: { text: "hi" }, created_at: "t", updated_at: "t", author_name: "Priya" };
    tables.session_inputs = [
      { ...waiting, id: "mine", author_user_id: caller.userId },
      { ...waiting, id: "theirs", author_user_id: "user-9" },
      { ...waiting, id: "done", author_user_id: caller.userId, state: "consumed" },
      { ...waiting, id: "control", author_user_id: caller.userId, kind: "stop" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { inputs: Array<{ id: string; mine: boolean; text: string }> };
    expect(body.inputs.map((i) => [i.id, i.mine, i.text])).toEqual([["mine", true, "hi"], ["theirs", false, "hi"]]);
  });

  it("returns the session, viewer, events and waiting inputs of a Draft turn", async () => {
    tables.users.push({ id: "user-9", display_name: "Priya Shah", email: "priya@example.test" });
    const previous = session({ id: "old", status: "ended", end_reason: "cleared", title: "Old chat", folder_name: "app" });
    const current = session({ previous_session_id: "old", title: "Fix login", folder_name: "app" });
    tables.sessions = [previous, current];
    tables.session_events = [
      { session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message", payload: { text: "Fix the login bug" }, created_at: "t1" },
      { session_id: SESSION, workspace_id: WS, seq: 2, kind: "assistant_text", payload: { text: "On it" }, created_at: "t2" },
    ];
    tables.session_inputs = [
      { session_id: SESSION, workspace_id: WS, kind: "message", state: "consumed", consumed_seq: 1, author_user_id: "user-9", payload: { text: "Fix the login bug" }, created_at: "t0", updated_at: "t0" },
      { id: "w", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", payload: { text: "hi" }, reason: null, created_at: "t3", updated_at: "t3", author_user_id: "user-1", author_name: "maya@example.test" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const { authors: _authors, ...body } = (await (await routes.EVENTS(req)).json()) as Row;
    expect(body).toEqual({
      session: { ...current, owner_name: "Maya", mine: true, previous_session: previous, next_session: null },
      viewer: { id: "user-1", name: "Maya" },
      events: [
        { session_id: SESSION, workspace_id: WS, seq: 1, kind: "user_message", payload: { text: "Fix the login bug" }, created_at: "t1", author_user_id: "user-9", author_name: "Priya Shah" },
        { session_id: SESSION, workspace_id: WS, seq: 2, kind: "assistant_text", payload: { text: "On it" }, created_at: "t2" },
      ],
      inputs: [{ id: "w", author_user_id: "user-1", author_name: "Maya", kind: "message", text: "hi", state: "queued", reason: null, created_at: "t3", updated_at: "t3", mine: true }],
    });
  });

  it("returns the senders of consumed messages with their current names", async () => {
    tables.users.push({ id: "user-9", display_name: "Priya Shah", email: "priya@example.test" });
    tables.session_inputs = [
      { session_id: SESSION, workspace_id: WS, kind: "message", state: "consumed", consumed_seq: 4, author_user_id: "user-1" },
      { session_id: SESSION, workspace_id: WS, kind: "message", state: "consumed", consumed_seq: 1, author_user_id: "user-9" },
      { session_id: SESSION, workspace_id: WS, kind: "message", state: "queued", payload: { text: "later" }, created_at: "t", updated_at: "t", author_user_id: "user-9", author_name: "priya@example.test" },
      { session_id: SESSION, workspace_id: WS, kind: "stop", state: "consumed", consumed_seq: 5, author_user_id: "user-1" },
    ];
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const body = (await (await routes.EVENTS(req)).json()) as { authors: Row[] };
    expect(body.authors).toEqual([
      { seq: 4, author_user_id: "user-1", author_name: "Maya" },
      { seq: 1, author_user_id: "user-9", author_name: "Priya Shah" },
    ]);
  });

  it("refuses events to a caller the workspace does not admit", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const req = Object.assign(new Request("http://localhost/x?after=0"), { params: { id: WS, sessionId: SESSION } }) as never;
    const res = await routes.EVENTS(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("stores the harness and model of a new session and rejects unknown ones", async () => {
    expect((await routes.CREATE(post("/x", { hostId: "host-1", harness: "claude", model: "haiku" }, { id: WS }))).status).toBe(201);
    expect(inserted.at(-1)).toMatchObject({ harness: "claude", model: "haiku" });

    await routes.CREATE(post("/x", { hostId: "host-1" }, { id: WS }));
    expect(inserted.at(-1)).toMatchObject({ harness: "claude" });

    const unknownHarness = await routes.CREATE(post("/x", { hostId: "host-1", harness: "gemini" }, { id: WS }));
    expect(unknownHarness.status).toBe(400);
    expect(((await unknownHarness.json()) as { error: string }).error).toBe("unknown_harness");
    expect((await routes.CREATE(post("/x", { hostId: "host-1", model: "gpt-5; rm -rf /" }, { id: WS }))).status).toBe(400);
  });

  it("stores the reasoning effort and rejects one the model does not list", async () => {
    expect((await routes.CREATE(post("/x", { hostId: "host-1", harness: "codex", model: "gpt-6-sol", reasoningEffort: "ultra" }, { id: WS }))).status).toBe(201);
    expect(inserted.at(-1)).toMatchObject({ model: "gpt-6-sol", reasoning_effort: "ultra" });

    await routes.CREATE(post("/x", { hostId: "host-1", harness: "codex", model: "gpt-6-sol" }, { id: WS }));
    expect(inserted.at(-1)).toMatchObject({ reasoning_effort: null });

    const luna = await routes.CREATE(post("/x", { hostId: "host-1", harness: "codex", model: "gpt-6-luna", reasoningEffort: "ultra" }, { id: WS }));
    expect(luna.status).toBe(400);
    expect(((await luna.json()) as { error: string }).error).toBe("unknown_reasoning_effort");
    expect((await routes.CREATE(post("/x", { hostId: "host-1", harness: "claude", reasoningEffort: "ultra" }, { id: WS }))).status).toBe(400);
  });

  it("fails the queued messages of a cleared session with their own reason", async () => {
    await routes.END(post("/x", { hostId: "host-1", reason: "cleared" }));
    expect(updates.find((u) => u.table === "session_inputs")?.payload).toMatchObject({ state: "failed", reason: "session_cleared" });
  });

  it("links a new session to the one it replaces, only for the owner's own host", async () => {
    const ok = await routes.CREATE(post("/x", { hostId: "host-1", previousSessionId: SESSION, harnessVersion: "2.1.0" }, { id: WS }));
    expect(ok.status).toBe(201);
    expect(inserted[0]).toMatchObject({ previous_session_id: SESSION, harness_version: "2.1.0" });

    expect((await routes.CREATE(post("/x", { hostId: "host-2", previousSessionId: SESSION }, { id: WS }))).status).toBe(403);
    expect((await routes.CREATE(post("/x", { hostId: "host-1", previousSessionId: "other" }, { id: WS }))).status).toBe(404);
  });

  it("saves the model and effort a host reports, and ignores a pair the harness does not list", async () => {
    tables.sessions = [{ id: SESSION, workspace_id: WS, owner_user_id: "user-1", host_id: "host-1", harness: "codex", model: "gpt-6-sol", reasoning_effort: null }];
    rpcResult = { data: "live", error: null };
    await routes.HEARTBEAT(post("/x", { hostId: "host-1", model: "gpt-6-luna", reasoningEffort: "xhigh" }));
    expect(updates.find((u) => u.table === "sessions")?.payload).toEqual({ model: "gpt-6-luna", reasoning_effort: "xhigh" });

    updates = [];
    await routes.HEARTBEAT(post("/x", { hostId: "host-1", model: "gpt-6-luna", reasoningEffort: "ultra" }));
    expect(updates.filter((u) => u.table === "sessions")).toEqual([]);
    await routes.HEARTBEAT(post("/x", { hostId: "host-1", harnessVersion: "1.0.0" }));
    expect(updates.filter((u) => u.table === "sessions")).toEqual([]);
  });

  it("passes a heartbeat to the database and maps its errors", async () => {
    rpcResult = { data: "live", error: null };
    const ok = await routes.HEARTBEAT(post("/x", { hostId: "host-1", harnessVersion: "2.1.0" }));
    expect(await ok.json()).toEqual({ ok: true, status: "live" });
    expect(rpcCalls[0]).toEqual({ fn: "heartbeat_session", args: { p_session_id: SESSION, p_workspace_id: WS, p_host_id: "host-1", p_harness_version: "2.1.0", p_permission_mode: null, p_approval_mode: null } });

    await routes.HEARTBEAT(post("/x", { hostId: "host-1", permissionMode: "plan", approvalMode: "full-access" }));
    expect(rpcCalls.at(-1)!.args).toMatchObject({ p_permission_mode: "plan", p_approval_mode: "full-access" });
    await routes.HEARTBEAT(post("/x", { hostId: "host-1", permissionMode: "rm -rf", approvalMode: 4 }));
    expect(rpcCalls.at(-1)!.args).toMatchObject({ p_permission_mode: null, p_approval_mode: null });

    expect((await routes.HEARTBEAT(post("/x", {}))).status).toBe(400);
    rpcResult = { data: null, error: { message: "session_ended" } };
    expect((await routes.HEARTBEAT(post("/x", { hostId: "host-1" }))).status).toBe(409);
    rpcResult = { data: null, error: { message: "foreign_host" } };
    expect((await routes.HEARTBEAT(post("/x", { hostId: "host-2" }))).status).toBe(403);
  });

  it("ends a session only for its owner on its own host", async () => {
    expect((await routes.END(post("/x", { hostId: "host-2" }))).status).toBe(403);
    const ok = await routes.END(post("/x", { hostId: "host-1", reason: "user_exit" }));
    expect(ok.status).toBe(200);
    expect(updates.find((u) => u.table === "sessions")?.payload).toMatchObject({ status: "ended", end_reason: "user_exit" });
    expect(updates.find((u) => u.table === "session_inputs")?.payload).toMatchObject({ state: "failed", reason: "session_ended" });
  });

  describe("deleting a session", () => {
    const del = () => routes.DELETE(post("/x", {}));

    it("ends a live session and hides it, and fails its queued messages", async () => {
      tables.sessions = [session({ session_type: "interactive", status: "live" })];
      expect((await del()).status).toBe(200);
      expect(updates.find((u) => u.table === "sessions")?.payload).toMatchObject({ status: "ended", end_reason: "deleted", open_approval_count: 0, deleted_at: expect.any(String) });
      expect(updates.find((u) => u.table === "session_inputs")?.payload).toMatchObject({ state: "failed", reason: "session_ended" });
    });

    it("deletes the folder snapshot a cloud session started from, and no other object", async () => {
      const key = `${WS}/${SESSION}/seed.tar.gz`;
      tables.sessions = [session({ session_type: "interactive", status: "sleeping", execution_target: "sandbox", seed: { kind: "snapshot", storageKey: key } })];
      expect((await del()).status).toBe(200);
      expect(removedObjects).toEqual([key]);
    });

    it("leaves the snapshot alone for a session that started from a repository", async () => {
      tables.sessions = [session({ session_type: "interactive", status: "sleeping", execution_target: "sandbox", seed: { kind: "repo", branch: "main" } })];
      expect((await del()).status).toBe(200);
      expect(removedObjects).toEqual([]);
    });

    it("keeps the end details of a session that already ended", async () => {
      tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "exited" })];
      expect((await del()).status).toBe(200);
      const payload = updates.find((u) => u.table === "sessions")!.payload;
      expect(payload.deleted_at).toEqual(expect.any(String));
      expect(payload).not.toHaveProperty("end_reason");
      expect(payload).not.toHaveProperty("status");
    });

    it("is owner only", async () => {
      tables.sessions = [session({ session_type: "interactive", owner_user_id: "user-2" })];
      expect((await del()).status).toBe(403);
      expect(updates.find((u) => u.table === "sessions")).toBeUndefined();
    });

    it("answers not found for a session that is already deleted", async () => {
      tables.sessions = [session({ session_type: "interactive", deleted_at: "t" })];
      expect((await del()).status).toBe(404);
    });

    it("does not delete a routine session", async () => {
      tables.sessions = [session({ session_type: "routine" })];
      expect((await del()).status).toBe(409);
    });

    it("hides a deleted session from the list and the events route, and blocks reopening it", async () => {
      tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "exited", deleted_at: "t" })];
      const list = await routes.LIST(post("/x", {}, { id: WS }));
      expect((await list.json()).sessions).toEqual([]);
      expect((await routes.EVENTS(Object.assign(new Request("http://localhost/x"), { params: { id: WS, sessionId: SESSION } }) as never)).status).toBe(404);
      expect((await routes.REOPEN(post("/x", { hostId: "host-1" }))).status).toBe(404);
    });
  });

  it("reopens an ended session as the same session, only on its own host", async () => {
    tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "exited", ended_at: "t" })];
    expect((await routes.REOPEN(post("/x", { hostId: "host-2" }))).status).toBe(403);
    const ok = await routes.REOPEN(post("/x", { hostId: "host-1" }));
    expect(ok.status).toBe(200);
    expect(updates.find((u) => u.table === "sessions")?.payload).toMatchObject({ status: "live", ended_at: null, end_reason: null });
    expect(inserted).toEqual([]);
  });

  it("does not reopen an ended cloud session", async () => {
    tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "start_failed", execution_target: "sandbox", host_id: "cloud:s1" })];
    updates = [];
    const res = await routes.REOPEN(post("/x", { hostId: "cloud:s1" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("cloud_session_ended");
    expect(updates).toEqual([]);
  });

  it("does not reopen a session that was cleared, a routine run, or one that is not ended", async () => {
    tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "cleared" })];
    const cleared = await routes.REOPEN(post("/x", { hostId: "host-1" }));
    expect(cleared.status).toBe(409);
    expect(((await cleared.json()) as { error: string }).error).toBe("session_cleared");

    tables.sessions = [session({ status: "ended", session_type: "routine" })];
    expect((await routes.REOPEN(post("/x", { hostId: "host-1" }))).status).toBe(409);

    tables.sessions = [session({ session_type: "interactive", status: "live" })];
    updates = [];
    expect((await routes.REOPEN(post("/x", { hostId: "host-1" }))).status).toBe(200);
    expect(updates).toEqual([]);
  });

  it("turns an oversize item into a note and records an error without a body", async () => {
    const res = await routes.LINES(
      post("/x", { hostId: "host-1", lines: [{ stream: "root.jsonl", position: 40, oversizeBytes: 9_000_000 }] }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0].args.p_events).toEqual([
      { source_id: "root.jsonl:40", kind: "session_note", payload: { text: "A very large item was skipped", reason: "too_large", bytes: 9_000_000 } },
    ]);
    await Bun.sleep(5);
    expect(errorRows[0]).toMatchObject({ workspace_id: WS, session_id: SESSION, operation: "session" });
  });

  it("parses sub-agent lines with their agent id", async () => {
    const raw = JSON.stringify({ type: "assistant", uuid: "a1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "listing" }] } });
    await routes.LINES(post("/x", { hostId: "host-1", lines: [{ stream: "subagents/agent-abc.jsonl", position: 0, raw }] }));
    expect(rpcCalls[0].args.p_events).toEqual([
      { source_id: "a1", kind: "assistant_text", payload: { timestamp: null, agent_id: "abc", text: "listing" } },
    ]);
  });
});

describe("raw upload routes", () => {
  it("returns a signed upload URL per file under the workspace and session folder", async () => {
    const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostId: "host-1", files: ["root.jsonl", "subagents/agent-abc.jsonl"] }));
    expect(res.status).toBe(200);
    expect(signedPaths).toEqual([`${WS}/${SESSION}/root.jsonl.gz`, `${WS}/${SESSION}/subagents/agent-abc.jsonl.gz`]);
    const body = (await res.json()) as { uploads: Array<{ file: string; signedUrl: string }> };
    expect(body.uploads.map((u) => u.file)).toEqual(["root.jsonl", "subagents/agent-abc.jsonl"]);
  });

  it("rejects file names that could escape the session folder", async () => {
    for (const files of [["../other/root.jsonl"], ["root.jsonl.gz"], ["subagents/../root.jsonl"], []]) {
      const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostId: "host-1", files }));
      expect(res.status).toBe(400);
    }
    expect(signedPaths).toEqual([]);
  });

  it("refuses a non-owner and a foreign host", async () => {
    tables.sessions = [session({ owner_user_id: "someone-else" })];
    expect((await routes.RAW_UPLOAD_URLS(post("/x", { hostId: "host-1", files: ["root.jsonl"] }))).status).toBe(403);
    tables.sessions = [session()];
    expect((await routes.RAW_UPLOAD_URLS(post("/x", { hostId: "host-2", files: ["root.jsonl"] }))).status).toBe(403);
    expect(signedPaths).toEqual([]);
  });

  it("still accepts uploads after the session has ended", async () => {
    tables.sessions = [session({ status: "ended" })];
    const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostId: "host-1", files: ["root.jsonl"] }));
    expect(res.status).toBe(200);
  });

  it("records the upload only when the root file is in storage", async () => {
    const missing = await routes.RAW_UPLOAD_COMPLETE(post("/x", { hostId: "host-1" }));
    expect(missing.status).toBe(409);
    expect(updates).toEqual([]);

    storageObjects = [{ name: "root.jsonl.gz" }];
    const ok = await routes.RAW_UPLOAD_COMPLETE(post("/x", { hostId: "host-1" }));
    expect(ok.status).toBe(200);
    expect(updates.at(-1)?.payload).toMatchObject({ raw_storage_path: `${WS}/${SESSION}/` });
    expect(updates.at(-1)?.payload.raw_uploaded_at).toBeString();
  });
});

const viewRoutes = await import("../../routes/sessions-view");

describe("session view route", () => {
  it("rejects conflicting, unsafe or malformed cursors", () => {
    for (const query of ["before=2&after=1", "around=-1", "after=1.5", "before=9007199254740992", "agentId=../other", "state=maybe", "limit=201"]) {
      expect(viewRoutes.parseViewQuery(new URLSearchParams(query))).toBeNull();
    }
    expect(viewRoutes.parseViewQuery(new URLSearchParams("after=0&through=20&state=false"))).toMatchObject({after:0,through:20,state:false});
  });

  it("authorizes before reading the scoped transcript", async () => {
    accessResult = Response.json({error:"forbidden"},{status:403});
    const request = Object.assign(new Request("https://test/view"),{params:{id:WS,sessionId:SESSION}});
    expect((await viewRoutes.VIEW(request as never)).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it("returns history-only pages without looking up current inputs or session links", async () => {
    const page = {agentId:null,events:[],dependencies:[],before:null,after:null,hasOlder:false,hasNewer:false,through:500,readThrough:500};
    rpcResult = {data:{page},error:null};
    const request = Object.assign(new Request("https://test/view?after=10&state=false"),{params:{id:WS,sessionId:SESSION}});
    const response = await viewRoutes.VIEW(request as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({page});
    expect(rpcCalls[0]).toMatchObject({fn:"read_session_view",args:{p_session_id:SESSION,p_workspace_id:WS,p_after:10,p_state:false}});
    expect(queriedTables).toEqual([]);
  });
});

describe("generic client error reports", () => {
  it("uses the shared recorder for an ordinary workspace error", async () => {
    const id = crypto.randomUUID();
    const response = await failures.POST(post("/errors", { id, code: "view_fetch_failed", operation: "read", message: "Load failed token=private", detail: { token: "private", status: 500 } }, { id: WS }));
    expect(response.status).toBe(200);
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]).toMatchObject({ id, workspace_id: WS, operation: "read", message: "Load failed token=[REDACTED]", detail_json: { code: "view_fetch_failed", token: "[REDACTED]", status: 500 } });
    expect(rpcCalls).toEqual([]);
  });

  it("rejects unauthorized and malformed generic reports", async () => {
    const body = { id: crypto.randomUUID(), code: "view_failed", operation: "read", message: "Load failed" };
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await failures.POST(post("/errors", body, { id: WS }))).status).toBe(403);
    accessResult = null;
    expect((await failures.POST(post("/errors", { ...body, operation: "unknown" }, { id: WS }))).status).toBe(400);
    expect(errorRows).toEqual([]);
  });
});

describe("cloud host requests", () => {
  const CLOUD_WS = "11111111-1111-4111-8111-111111111111";
  const RUN = "22222222-2222-4222-8222-222222222222";
  const CLOUD_HOST = `cloud:${SESSION}`;
  const SECRET = "live-sessions-cloud-test-secret";
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.SANDBOX_CALLBACK_SECRET;
    process.env.SANDBOX_CALLBACK_SECRET = SECRET;
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.SANDBOX_CALLBACK_SECRET;
    else process.env.SANDBOX_CALLBACK_SECRET = savedSecret;
  });

  /** A sandbox host calls with its run token, which names the run, the workspace and the session. */
  const cloudPost = (body: unknown, sessionId = SESSION) =>
    Object.assign(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { authorization: `Bearer ${createAgentRunToken({ runId: parseAgentRunId(RUN), workspaceId: parseWorkspaceId(CLOUD_WS), expiresAt: Date.now() + 60_000, nonce: "n", scope: "host" }, SECRET)}` },
        body: JSON.stringify(body),
      }),
      { params: { id: CLOUD_WS, sessionId } },
    ) as never;

  beforeEach(() => {
    tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: CLOUD_HOST })];
    tables.agent_runs = [{ id: RUN, workspace_id: CLOUD_WS, kind: "interactive", status: "running", session_id: SESSION }];
  });

  it("accepts delayed diagnostics from a finished run without ending its replacement", async () => {
    tables.agent_runs[0]!.status = "succeeded";
    const sessionId = crypto.randomUUID();
    tables.sessions[0]!.id = sessionId;
    tables.sessions[0]!.host_id = `cloud:${sessionId}`;
    tables.agent_runs[0]!.session_id = sessionId;
    const response = await failures.POST(cloudPost({ id: crypto.randomUUID(), sessionId, operation: "session", code: "host_exited", message: "Session ended", detail: { phase: "host_exited" }, sessionFailure: { requestId: null, at: new Date().toISOString(), terminal: true } }, sessionId));
    expect(response.status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "report_session_failure", args: { p_terminal: false } });
    expect((await routes.HEARTBEAT(cloudPost({}, sessionId))).status).toBe(403);
  });

  it("posts lines under the cloud host id, and refuses a body that names a desktop host", async () => {
    expect((await routes.LINES(cloudPost({ lines: [userLine("u1", "hi")] }))).status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "append_session_events", args: { p_session_id: SESSION, p_workspace_id: CLOUD_WS, p_host_id: CLOUD_HOST } });

    rpcCalls.length = 0;
    const foreign = await routes.LINES(cloudPost({ hostId: "host-1", lines: [userLine("u2", "hi")] }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ ok: false, error: "foreign_host" });
    expect(rpcCalls).toEqual([]);
  });

  it("heartbeats under the cloud host id, and refuses another host", async () => {
    rpcResult = { data: "live", error: null };
    expect((await routes.HEARTBEAT(cloudPost({}))).status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "heartbeat_session", args: { p_session_id: SESSION, p_workspace_id: CLOUD_WS, p_host_id: CLOUD_HOST } });

    rpcCalls.length = 0;
    expect((await routes.HEARTBEAT(cloudPost({ hostId: "host-1" }))).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it("ends its own session, and refuses an end from another host", async () => {
    expect((await routes.END(cloudPost({ hostId: "host-1", reason: "user_exit" }))).status).toBe(403);
    expect(updates).toEqual([]);

    expect((await routes.END(cloudPost({ reason: "user_exit" }))).status).toBe(200);
    expect(updates.find((u) => u.table === "sessions")?.payload).toMatchObject({ status: "ended", end_reason: "user_exit" });
  });

  it("closes its run as succeeded on a normal end, and as failed when the host failed", async () => {
    expect((await routes.END(cloudPost({ reason: "user_exit" }))).status).toBe(200);
    expect(updates.find((u) => u.table === "agent_runs")?.payload).toMatchObject({ status: "succeeded" });

    updates = [];
    tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: CLOUD_HOST })];
    expect((await routes.END(cloudPost({ reason: "host_failed" }))).status).toBe(200);
    expect(updates.find((u) => u.table === "agent_runs")?.payload).toMatchObject({ status: "failed", failure_code: "host_failed" });
  });

  it("reads its own session with its run token, as the owner and without a membership check", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const read = Object.assign(new Request("http://localhost/x?after=0&limit=1", { headers: (cloudPost({}) as unknown as Request).headers }), { params: { id: CLOUD_WS, sessionId: SESSION } }) as never;
    const response = await routes.EVENTS(read);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: unknown }).session).toMatchObject({ id: SESSION, mine: true });
  });

  it("uploads raw files under its own session folder", async () => {
    expect((await routes.RAW_UPLOAD_URLS(cloudPost({ files: ["root.jsonl"] }))).status).toBe(200);
    expect(signedPaths).toEqual([`${CLOUD_WS}/${SESSION}/root.jsonl.gz`]);

    storageObjects = [{ name: "root.jsonl.gz" }];
    expect((await routes.RAW_UPLOAD_COMPLETE(cloudPost({ hostId: "host-1" }))).status).toBe(403);
    expect((await routes.RAW_UPLOAD_COMPLETE(cloudPost({}))).status).toBe(200);
  });

  it("refuses a run that names another session", async () => {
    tables.sessions.push(session({ id: "session-2", workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: "cloud:session-2" }));
    const res = await routes.LINES(cloudPost({ lines: [userLine("u1", "hi")] }, "session-2"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "run_not_for_session" });
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a finished run, and a run on a local session", async () => {
    tables.agent_runs = [{ id: RUN, workspace_id: CLOUD_WS, kind: "interactive", status: "succeeded", session_id: SESSION }];
    const finished = await routes.HEARTBEAT(cloudPost({}));
    expect(finished.status).toBe(403);
    expect(await finished.json()).toEqual({ ok: false, error: "run_not_active" });

    tables.agent_runs = [{ id: RUN, workspace_id: CLOUD_WS, kind: "interactive", status: "running", session_id: SESSION }];
    tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "host", host_id: "host-1" })];
    const local = await routes.HEARTBEAT(cloudPost({}));
    expect(local.status).toBe(403);
    expect(await local.json()).toEqual({ ok: false, error: "session_not_cloud" });
    expect(rpcCalls).toEqual([]);
  });

  it("does not need team membership, since its token binds it to the session", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await routes.LINES(cloudPost({ lines: [userLine("u1", "hi")] }))).status).toBe(200);
  });

  describe("sleep", () => {
    it("ends the run as succeeded and then sleeps the session when the cloud host asks", async () => {
      const res = await routes.HOST_SLEEP(cloudPost({ hostId: CLOUD_HOST }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "sleeping" });
      expect(updates.map((u) => u.table)).toEqual(["agent_runs", "sessions"]);
      expect(updates[0].payload).toMatchObject({ status: "succeeded", completed_at: expect.any(String) });
      expect(updates[1].payload).toEqual({ status: "sleeping" });
    });

    it("sleeps a session that is starting, live or offline", async () => {
      for (const status of ["starting", "live", "host_offline"]) {
        tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: CLOUD_HOST, status })];
        updates = [];
        expect((await routes.HOST_SLEEP(cloudPost({}))).status).toBe(200);
      }
    });

    it("refuses a user caller, since only a cloud host sleeps its session", async () => {
      const res = await routes.HOST_SLEEP(post("/x", {}, { id: CLOUD_WS, sessionId: SESSION }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: "cloud_host_only" });
      expect(updates).toEqual([]);
    });

    it("refuses a host that names another host, and a session that is already sleeping or ended", async () => {
      expect((await routes.HOST_SLEEP(cloudPost({ hostId: "host-1" }))).status).toBe(403);
      expect(updates).toEqual([]);

      tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: CLOUD_HOST, status: "ended" })];
      const ended = await routes.HOST_SLEEP(cloudPost({}));
      expect(ended.status).toBe(409);
      expect(await ended.json()).toEqual({ ok: false, error: "session_ended" });

      tables.sessions = [session({ workspace_id: CLOUD_WS, execution_target: "sandbox", host_id: CLOUD_HOST, status: "sleeping" })];
      const sleeping = await routes.HOST_SLEEP(cloudPost({}));
      expect(sleeping.status).toBe(409);
      expect(await sleeping.json()).toEqual({ ok: false, error: "session_sleeping" });
      expect(updates).toEqual([]);
    });

    it("refuses to sleep while an input is queued or being pasted, and leaves the run active", async () => {
      for (const state of ["queued", "delivering"]) {
        tables.session_inputs = [{ id: `input-${state}`, session_id: SESSION, workspace_id: CLOUD_WS, kind: "message", state }];
        const res = await routes.HOST_SLEEP(cloudPost({}));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ ok: false, error: "inputs_pending" });
      }
      expect(updates).toEqual([]);
    });

    it("refuses for a waiting control input too, since the host counts every kind as pending", async () => {
      tables.session_inputs = [{ id: "stop-1", session_id: SESSION, workspace_id: CLOUD_WS, kind: "stop", state: "queued" }];
      const res = await routes.HOST_SLEEP(cloudPost({}));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "inputs_pending" });
      expect(updates).toEqual([]);
    });

    it("sleeps when every input is already taken, failed, cancelled or uncertain", async () => {
      tables.session_inputs = ["consumed", "failed", "cancelled", "uncertain"].map((state, index) => ({
        id: `input-${index}`,
        session_id: SESSION,
        workspace_id: CLOUD_WS,
        kind: "message",
        state,
      }));
      const res = await routes.HOST_SLEEP(cloudPost({}));
      expect(res.status).toBe(200);
      expect(updates.map((u) => u.table)).toEqual(["agent_runs", "sessions"]);
    });
  });
});
