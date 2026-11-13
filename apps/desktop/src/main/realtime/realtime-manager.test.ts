import { describe, expect, it } from "bun:test";
import { SIGNAL_EVENTS } from "draft-core/live-sessions";
import { RealtimeManager } from "./realtime-manager";

function setup() {
  const joined: string[] = [];
  const left: string[] = [];
  const emit = new Map<string, (event: string) => void>();
  const status = new Map<string, (connected: boolean) => void>();
  const toWindow: Array<[string, string]> = [];
  const connection: boolean[] = [];
  const manager = new RealtimeManager(
    (topic, onEvent, onConnected) => {
      joined.push(topic);
      emit.set(topic, onEvent);
      status.set(topic, onConnected);
      return () => void left.push(topic);
    },
    (topic, event) => void toWindow.push([topic, event]),
    (connected) => void connection.push(connected),
  );
  return {
    manager, joined, left, toWindow, connection,
    emit: (topic: string, event: string) => emit.get(topic)?.(event),
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
