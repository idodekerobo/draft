import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LiveTextChunk } from "draft-core/live-sessions";
import { realtime } from "../../realtime/instance";
import type { HostSessionState } from "../cursor-store";
import type { DriverHost } from "../harness-driver";
import { CodexDriver } from "./codex-driver";

const state: HostSessionState = {
  sessionId: "s1",
  workspaceId: "w1",
  hostMachineId: "m1",
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
};

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Notify = (method: string, params: unknown) => void;

describe("CodexDriver live text", () => {
  let sent: Array<{ topic: string; event: string; chunk: LiveTextChunk }> = [];
  const original = realtime.send;

  beforeEach(() => {
    sent = [];
    realtime.send = (topic, event, payload) => void sent.push({ topic, event, chunk: payload as LiveTextChunk });
  });
  afterEach(() => {
    realtime.send = original;
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
