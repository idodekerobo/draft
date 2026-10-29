import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: { last_seq: 2, inserted: 2 }, error: null };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let storageObjects: Array<{ name: string }> = [];
const signedPaths: string[] = [];

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
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string) => {
          signedPaths.push(path);
          return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null };
        },
        list: async () => ({ data: storageObjects, error: null }),
      }),
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
  rpcResult = { data: { last_seq: 2, inserted: 2 }, error: null };
  rpcCalls.length = 0;
  storageObjects = [];
  signedPaths.length = 0;
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
    const res = await routes.CREATE(post("/x", { hostMachineId: "host-1" }, { id: WS }));
    expect(res.status).toBe(403);
    expect(inserted).toEqual([]);
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

  it("leaves the author tag of a Draft message out of the title", async () => {
    await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [userLine("u1", "[Maya via Draft] hello there")] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "hello there" }]);
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

  it("replaces the first-prompt title with Claude Code's ai-title, and a rename beats it", async () => {
    tables.sessions = [session({ title: "Fix the login bug" })];
    const aiLine = { file: "root.jsonl", offset: 9, raw: '{"type":"ai-title","aiTitle":"Login bug fix"}' };
    await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [aiLine] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "Login bug fix" }]);

    updates = [];
    const renamed = { file: "root.jsonl", offset: 10, raw: '{"type":"custom-title","customTitle":"login-work"}' };
    await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [aiLine, renamed] }));
    expect(updates.map((u) => u.payload)).toEqual([{ title: "login-work" }]);
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
    const body = (await (await routes.EVENTS(req)).json()) as { session: Row; events: Row[]; inputs: Row[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    expect(body.session.owner_name).toBe("Maya");
    expect(body.session.mine).toBe(true);
    expect((body as unknown as { viewer: unknown }).viewer).toEqual({ id: "user-1", name: "Maya" });
    expect(body.inputs).toEqual([]);
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

  it("stores the harness and model of a new session and rejects unknown ones", async () => {
    expect((await routes.CREATE(post("/x", { hostMachineId: "host-1", harness: "claude", model: "haiku" }, { id: WS }))).status).toBe(201);
    expect(inserted.at(-1)).toMatchObject({ harness: "claude", model: "haiku" });

    await routes.CREATE(post("/x", { hostMachineId: "host-1" }, { id: WS }));
    expect(inserted.at(-1)).toMatchObject({ harness: "claude" });

    const unknownHarness = await routes.CREATE(post("/x", { hostMachineId: "host-1", harness: "gemini" }, { id: WS }));
    expect(unknownHarness.status).toBe(400);
    expect(((await unknownHarness.json()) as { error: string }).error).toBe("unknown_harness");
    expect((await routes.CREATE(post("/x", { hostMachineId: "host-1", model: "gpt-5; rm -rf /" }, { id: WS }))).status).toBe(400);
  });

  it("fails the queued messages of a cleared session with their own reason", async () => {
    await routes.END(post("/x", { hostMachineId: "host-1", reason: "cleared" }));
    expect(updates.find((u) => u.table === "session_inputs")?.payload).toMatchObject({ state: "failed", reason: "session_cleared" });
  });

  it("links a new session to the one it replaces, only for the owner's own host", async () => {
    const ok = await routes.CREATE(post("/x", { hostMachineId: "host-1", previousSessionId: SESSION, harnessVersion: "2.1.0" }, { id: WS }));
    expect(ok.status).toBe(201);
    expect(inserted[0]).toMatchObject({ previous_session_id: SESSION, harness_version: "2.1.0" });

    expect((await routes.CREATE(post("/x", { hostMachineId: "host-2", previousSessionId: SESSION }, { id: WS }))).status).toBe(403);
    expect((await routes.CREATE(post("/x", { hostMachineId: "host-1", previousSessionId: "other" }, { id: WS }))).status).toBe(404);
  });

  it("passes a heartbeat to the database and maps its errors", async () => {
    rpcResult = { data: "live", error: null };
    const ok = await routes.HEARTBEAT(post("/x", { hostMachineId: "host-1", harnessVersion: "2.1.0" }));
    expect(await ok.json()).toEqual({ ok: true, status: "live" });
    expect(rpcCalls[0]).toEqual({ fn: "heartbeat_session", args: { p_session_id: SESSION, p_workspace_id: WS, p_host_machine_id: "host-1", p_harness_version: "2.1.0" } });

    expect((await routes.HEARTBEAT(post("/x", {}))).status).toBe(400);
    rpcResult = { data: null, error: { message: "session_ended" } };
    expect((await routes.HEARTBEAT(post("/x", { hostMachineId: "host-1" }))).status).toBe(409);
    rpcResult = { data: null, error: { message: "foreign_host" } };
    expect((await routes.HEARTBEAT(post("/x", { hostMachineId: "host-2" }))).status).toBe(403);
  });

  it("ends a session only for its owner on its own host", async () => {
    expect((await routes.END(post("/x", { hostMachineId: "host-2" }))).status).toBe(403);
    const ok = await routes.END(post("/x", { hostMachineId: "host-1", reason: "user_exit" }));
    expect(ok.status).toBe(200);
    expect(updates.find((u) => u.table === "sessions")?.payload).toMatchObject({ status: "ended", end_reason: "user_exit" });
    expect(updates.find((u) => u.table === "session_inputs")?.payload).toMatchObject({ state: "failed", reason: "session_ended" });
  });

  it("turns an oversize item into a note and records an error without a body", async () => {
    const res = await routes.LINES(
      post("/x", { hostMachineId: "host-1", lines: [{ file: "root.jsonl", offset: 40, oversizeBytes: 9_000_000 }] }),
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
    await routes.LINES(post("/x", { hostMachineId: "host-1", lines: [{ file: "subagents/agent-abc.jsonl", offset: 0, raw }] }));
    expect(rpcCalls[0].args.p_events).toEqual([
      { source_id: "a1", kind: "assistant_text", payload: { timestamp: null, agent_id: "abc", text: "listing" } },
    ]);
  });
});

describe("raw upload routes", () => {
  it("returns a signed upload URL per file under the workspace and session folder", async () => {
    const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostMachineId: "host-1", files: ["root.jsonl", "subagents/agent-abc.jsonl"] }));
    expect(res.status).toBe(200);
    expect(signedPaths).toEqual([`${WS}/${SESSION}/root.jsonl.gz`, `${WS}/${SESSION}/subagents/agent-abc.jsonl.gz`]);
    const body = (await res.json()) as { uploads: Array<{ file: string; signedUrl: string }> };
    expect(body.uploads.map((u) => u.file)).toEqual(["root.jsonl", "subagents/agent-abc.jsonl"]);
  });

  it("rejects file names that could escape the session folder", async () => {
    for (const files of [["../other/root.jsonl"], ["root.jsonl.gz"], ["subagents/../root.jsonl"], []]) {
      const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostMachineId: "host-1", files }));
      expect(res.status).toBe(400);
    }
    expect(signedPaths).toEqual([]);
  });

  it("refuses a non-owner and a foreign host", async () => {
    tables.sessions = [session({ owner_user_id: "someone-else" })];
    expect((await routes.RAW_UPLOAD_URLS(post("/x", { hostMachineId: "host-1", files: ["root.jsonl"] }))).status).toBe(403);
    tables.sessions = [session()];
    expect((await routes.RAW_UPLOAD_URLS(post("/x", { hostMachineId: "host-2", files: ["root.jsonl"] }))).status).toBe(403);
    expect(signedPaths).toEqual([]);
  });

  it("still accepts uploads after the session has ended", async () => {
    tables.sessions = [session({ status: "ended" })];
    const res = await routes.RAW_UPLOAD_URLS(post("/x", { hostMachineId: "host-1", files: ["root.jsonl"] }));
    expect(res.status).toBe(200);
  });

  it("records the upload only when the root file is in storage", async () => {
    const missing = await routes.RAW_UPLOAD_COMPLETE(post("/x", { hostMachineId: "host-1" }));
    expect(missing.status).toBe(409);
    expect(updates).toEqual([]);

    storageObjects = [{ name: "root.jsonl.gz" }];
    const ok = await routes.RAW_UPLOAD_COMPLETE(post("/x", { hostMachineId: "host-1" }));
    expect(ok.status).toBe(200);
    expect(updates.at(-1)?.payload).toMatchObject({ raw_storage_path: `${WS}/${SESSION}/` });
    expect(updates.at(-1)?.payload.raw_uploaded_at).toBeString();
  });
});
