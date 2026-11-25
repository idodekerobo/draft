import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { LiveTextChunk } from "../../../../live-sessions";
import { installHostServices } from "../../../../host/services";
import { fakeHostServices } from "../../fake-host-services";
import type { HostSessionState } from "../../../../host/cursor-store";
import type { DriverHost } from "../../../../host/drivers/harness-driver";
import { CodexDriver, codex } from "../../../../host/drivers/codex/codex-driver";
import * as appServer from "../../../../host/drivers/codex/app-server-process";
import { RpcClient } from "../../../../host/drivers/codex/rpc-client";

describe("Codex launch modes", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  it("waits for initial Plan and full-access settings before returning the new session", async () => {
    let apply!: () => void;
    const applied = new Promise<void>((resolve) => { apply = resolve; });
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "launch-plan-thread" }, model: "gpt-6.1-sol" };
        if (method === "thread/settings/update") await applied;
        return {};
      },
      notify: () => {}, close: () => {},
    };
    spies.push(spyOn(appServer, "startAppServer").mockResolvedValue({ url: "ws://fake", token: "fake", stop: () => {}, exited: new Promise<number>(() => {}) }));
    spies.push(spyOn(RpcClient, "connect").mockResolvedValue(rpc as unknown as RpcClient));
    let finished = false;
    const launched = codex.launcher.launch({
      sessionId: "launch-plan-session", workspace: { path: "/tmp" }, nativeSessionId: "", model: null, effort: "high",
      options: { bin: "codex", permissionMode: "plan", approvalMode: "full-access" },
    }).then((value) => { finished = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(calls.at(-1)).toEqual({ method: "thread/settings/update", params: {
      threadId: "launch-plan-thread", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } },
    } });
    apply();
    expect(await launched).toMatchObject({ codexPermissionMode: "plan", codexApprovalMode: "full-access" });
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });
});

const state: HostSessionState = {
  sessionId: "s1",
  workspaceId: "w1",
  hostId: "m1",
  nativeSessionId: "t1",
  folderPath: "/tmp",
  cursors: {},
  rawUploads: {},
  ended: false,
};

const host: DriverHost = {
  base: "workspaces/w1/live-sessions/s1",
  state: () => state,
  persist: () => {},
  postLines: async () => {},
  postHostEvents: async () => {},
  setInputState: async () => true,
  isFatal: () => false,
  onFatal: () => {},
  reportError: () => {},
  requestUpload: () => {},
  wake: () => {},
  reportModes: () => {},
    reportAgent: () => {},
};

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("CodexDriver approval changes", () => {
  function setup(saved: Partial<HostSessionState> = {}) {
    const localState = { ...state, ...saved };
    const reported: unknown[] = [];
    const notes: unknown[] = [];
    const inputStates: unknown[] = [];
    const driver = new CodexDriver({
      ...host,
      state: () => localState,
      persist: (patch) => Object.assign(localState, patch),
      reportModes: (modes) => { reported.push(modes); },
      postHostEvents: async (events) => { notes.push(...events); },
      setInputState: async (...args) => { inputStates.push(args); return true; },
    }) as unknown as {
      bind(connection: unknown): void;
      setMode(connection: unknown, payload: unknown): Promise<string | null>;
      deliver(connection: unknown, messages: unknown[]): Promise<void>;
      ownedConnection: unknown;
      serve(inputs: unknown[]): Promise<void>;
    };
    const request = mock(async (_method: string, _params: unknown) => ({ turn: { id: "turn1" } }));
    const connection = {
      threadId: "t1", model: "gpt-6.1-sol", effort: "high", busy: false,
      approval: "approve-for-me", approvalChosen: true, collaboration: "default", collaborationChosen: false,
      rpc: { request },
    };
    driver.ownedConnection = connection;
    return { driver, connection, request, localState, reported, notes, inputStates };
  }

  it("clears the previous reviewer in Codex before reporting and persisting full access", async () => {
    const { driver, connection, request, localState, reported } = setup();
    expect(await driver.setMode(connection, { approvalMode: "full-access" })).toBeNull();
    expect(request).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "t1", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(localState.codexApprovalMode).toBe("full-access");
    expect(reported.at(-1)).toMatchObject({ approvalMode: "full-access" });
    await driver.deliver(connection, [{ id: "i1", kind: "message", state: "queued", delivered_text: "go" }]);
    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({ approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } }));
  });

  it("applies Plan before the first turn and sends Plan with that turn", async () => {
    const { driver, connection, request } = setup();
    expect(await driver.setMode(connection, { permissionMode: "plan" })).toBeNull();
    await driver.deliver(connection, [{ id: "i1", kind: "message", state: "queued", delivered_text: "go" }]);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "turn/start"]);
    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } },
    }));
  });

  it("keeps the previous settings when Codex rejects the approval update", async () => {
    const { driver, connection, request, localState, reported } = setup();
    request.mockImplementation(async () => { throw new Error("policy restriction"); });
    expect(await driver.setMode(connection, { approvalMode: "full-access" })).toContain("policy restriction");
    expect(connection.approval).toBe("approve-for-me");
    expect(localState.codexApprovalMode).toBeUndefined();
    expect(reported).toEqual([]);
  });

  it("does not start the queued first message under settings Codex rejected", async () => {
    const { driver, request, inputStates } = setup();
    request.mockImplementation(async () => { throw new Error("policy restriction"); });
    await driver.serve([
      { id: "mode1", kind: "set_mode", state: "queued", payload: { approvalMode: "full-access" } },
      { id: "i1", kind: "message", state: "queued", delivered_text: "go" },
    ]);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update"]);
    expect(inputStates).toContainEqual(["i1", ["queued"], "failed", "mode_failed"]);
  });

  it("restores chosen modes after reconnect and includes them in the next turn with the chosen effort", async () => {
    const { driver, connection, request } = setup({ codexApprovalMode: "full-access", codexPermissionMode: "plan" });
    driver.bind(connection);
    expect(connection.approval).toBe("full-access");
    expect(connection.collaboration).toBe("plan");
    await driver.deliver(connection, [{ id: "i1", kind: "message", state: "queued", delivered_text: "go" }]);
    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      approvalPolicy: "never", approvalsReviewer: "user",
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } },
    }));
  });

  it("explains that a running turn and pending permissions retain their previous settings", async () => {
    const { driver, connection, notes } = setup();
    connection.busy = true;
    await driver.setMode(connection, { approvalMode: "full-access" });
    expect(JSON.stringify(notes)).toContain("next turn");
    expect(JSON.stringify(notes)).toContain("pending permission requests");
  });
});

type Notify = (method: string, params: unknown) => void;

describe("CodexDriver live text", () => {
  let sent: Array<{ topic: string; event: string; chunk: LiveTextChunk }> = [];

  beforeEach(() => {
    sent = [];
    installHostServices(fakeHostServices({
      realtime: {
        connected: () => true,
        watch: () => () => {},
        send: (topic, event, payload) => void sent.push({ topic, event, chunk: payload as LiveTextChunk }),
      },
    }));
  });

  /** The driver reads notifications of its own thread; the connection is the fake a live app server would give it. */
  function driverWithThread() {
    const driver = new CodexDriver(host) as unknown as { onNotification(connection: unknown, method: string, params: unknown): void };
    const connection = { threadId: "t1", busy: false, turnId: null, hasTurned: false, history: [] };
    const notify: Notify = (method, params) => driver.onNotification(connection, method, params);
    return { notify };
  }

  const delta = (itemId: string, text: string, threadId = "t1") => ({ threadId, turnId: "u1", itemId, delta: text });

  it("sends the deltas of one item as chunks with that item id on the live topic", async () => {
    const { notify } = driverWithThread();
    notify("item/agentMessage/delta", delta("i1", "Hel"));
    notify("item/agentMessage/delta", delta("i1", "lo"));
    await wait(80);
    expect(sent).toEqual([{ topic: "live:session:s1", event: "text", chunk: { messageId: "i1", index: 0, text: "Hello", final: false } }]);
  });

  it("sends a final chunk when the item completes, and plan deltas are streamed the same way", async () => {
    const { notify } = driverWithThread();
    notify("item/plan/delta", delta("p1", "Step one"));
    await wait(80);
    notify("item/completed", { threadId: "t1", item: { id: "p1", type: "plan" } });
    expect(sent.map((s) => s.chunk)).toEqual([
      { messageId: "p1", index: 0, text: "Step one", final: false },
      { messageId: "p1", index: 1, text: "", final: true },
    ]);
  });

  it("does not stream a completed item of another type", async () => {
    const { notify } = driverWithThread();
    notify("item/completed", { threadId: "t1", item: { id: "c1", type: "commandExecution" } });
    await wait(80);
    expect(sent).toEqual([]);
  });

  it("ignores a delta for another thread", async () => {
    const { notify } = driverWithThread();
    notify("item/agentMessage/delta", delta("i1", "nope", "other-thread"));
    await wait(80);
    expect(sent).toEqual([]);
  });

  it("starts a fresh message when a delta arrives after the item completed", async () => {
    const { notify } = driverWithThread();
    notify("item/agentMessage/delta", delta("i1", "first"));
    await wait(80);
    notify("item/completed", { threadId: "t1", item: { id: "i1", type: "agentMessage", text: "first" } });
    notify("item/agentMessage/delta", delta("i1", "again"));
    await wait(80);
    expect(sent.slice(-1)[0]!.chunk).toEqual({ messageId: "i1", index: 0, text: "again", final: false });
  });
});

describe("CodexDriver turn end", () => {
  it("wakes the runner when a turn ends with a message waiting, and not otherwise", async () => {
    let wakes = 0;
    const driver = new CodexDriver({ ...host, wake: () => void wakes++ }) as unknown as {
      onNotification(connection: unknown, method: string, params: unknown): void;
      deliver(connection: unknown, messages: unknown[]): Promise<void>;
    };
    const connection = { threadId: "t1", busy: true, turnId: "u1", hasTurned: true, history: [] };

    driver.onNotification(connection, "turn/completed", { threadId: "t1", turn: { id: "u1" } });
    expect(wakes).toBe(0);

    connection.busy = true;
    connection.turnId = "u2";
    await driver.deliver(connection, [{ id: "i1", kind: "message", state: "queued", delivered_text: "hi" }]);
    driver.onNotification(connection, "turn/completed", { threadId: "t1", turn: { id: "u2" } });
    expect(wakes).toBe(1);
  });
});
