import { describe, expect, it } from "bun:test";
import { SIGNAL_EVENTS } from "draft-core/live-sessions";
import { RealtimeManager } from "./realtime-manager";

function setup() {
  const joined: string[] = [];
  const left: string[] = [];
  const emit = new Map<string, (event: string, payload?: unknown) => void>();
  const status = new Map<string, (connected: boolean) => void>();
  const toWindow: unknown[][] = [];
  const sent: unknown[][] = [];
  const connection: boolean[] = [];
  const manager = new RealtimeManager(
    (topic, onEvent, onConnected) => {
      joined.push(topic);
      emit.set(topic, onEvent);
      status.set(topic, onConnected);
      return { leave: () => void left.push(topic), send: (event, payload) => void sent.push([topic, event, payload]) };
    },
    (topic, event, payload) => void toWindow.push(payload === undefined ? [topic, event] : [topic, event, payload]),
    (connected) => void connection.push(connected),
  );
  return {
    manager, joined, left, toWindow, sent, connection,
    emit: (topic: string, event: string, payload?: unknown) => emit.get(topic)?.(event, payload),
    setConnected: (topic: string, connected: boolean) => status.get(topic)?.(connected),
  };
}

describe("RealtimeManager", () => {
  it("joins what the window newly wants, leaves what it dropped, and leaves the rest alone", () => {
    const t = setup();
    t.manager.setWindowTopics(["a", "b"]);
    t.manager.setWindowTopics(["b", "c"]);
    expect(t.joined).toEqual(["a", "b", "c"]);
    expect(t.left).toEqual(["a"]);
  });

  it("forwards signals of a watched topic to the window", () => {
    const t = setup();
    t.manager.setWindowTopics(["a"]);
    t.emit("a", "events");
    expect(t.toWindow).toEqual([["a", "events"]]);
  });

  it("passes a payload on to the listeners and to the window", () => {
    const t = setup();
    const heard: unknown[] = [];
    t.manager.watch("a", (_event, payload) => heard.push(payload));
    t.manager.setWindowTopics(["a"]);
    t.emit("a", "text", { text: "hi" });
    expect(heard).toEqual([{ text: "hi" }]);
    expect(t.toWindow).toEqual([["a", "text", { text: "hi" }]]);
  });

  it("sends through the held topic, and does nothing for a topic that is not held", () => {
    const t = setup();
    t.manager.watch("a", () => {});
    t.manager.send("a", "text", { text: "hi" });
    t.manager.send("unknown", "text", {});
    expect(t.sent).toEqual([["a", "text", { text: "hi" }]]);
  });

  it("drops everything the window held when the window is replaced", () => {
    const t = setup();
    t.manager.setWindowTopics(["a", "b"]);
    t.manager.clearWindow();
    expect(t.left.sort()).toEqual(["a", "b"]);
  });

  it("shares one channel between the window and a main-process listener, and keeps it until both are done", () => {
    const t = setup();
    const heard: string[] = [];
    const stopHost = t.manager.watch("a", (event) => heard.push(event));
    t.manager.setWindowTopics(["a"]);
    expect(t.joined).toEqual(["a"]);
    t.emit("a", "inputs");
    expect(heard).toEqual(["inputs"]);
    expect(t.toWindow).toEqual([["a", "inputs"]]);
    t.manager.clearWindow();
    expect(t.left).toEqual([]);
    stopHost();
    expect(t.left).toEqual(["a"]);
  });

  it("reports the connection when it changes, and tells a new page the state after each list", () => {
    const t = setup();
    t.manager.setWindowTopics(["a", "b"]);
    expect(t.connection).toEqual([false, false]);
    t.setConnected("a", true);
    t.setConnected("b", true);
    expect(t.connection).toEqual([false, false, true]);
    t.setConnected("b", false);
    t.manager.clearWindow();
    expect(t.connection).toEqual([false, false, true, false, true, true]);
  });

  it("gives a listener that joins a connected topic one catch-up, and the first listener none", async () => {
    const t = setup();
    const first: string[] = [];
    const second: string[] = [];
    t.manager.watch("a", (event) => first.push(event));
    t.setConnected("a", true);
    t.manager.watch("a", (event) => second.push(event));
    await Promise.resolve();
    expect(first).toEqual([]);
    expect(second).toEqual([SIGNAL_EVENTS.catchUp]);
  });

  it("gives no catch-up to a listener that joins a topic that is not connected", async () => {
    const t = setup();
    t.manager.watch("a", () => {});
    const late: string[] = [];
    t.manager.watch("a", (event) => late.push(event));
    await Promise.resolve();
    expect(late).toEqual([]);
  });

  it("skips the catch-up when the listener was removed before it ran", async () => {
    const t = setup();
    t.manager.watch("a", () => {});
    t.setConnected("a", true);
    const late: string[] = [];
    const stop = t.manager.watch("a", (event) => late.push(event));
    stop();
    await Promise.resolve();
    expect(late).toEqual([]);
  });
});
