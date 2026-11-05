import { describe, expect, it } from "bun:test";
import { RealtimeManager } from "./realtime-manager";

function setup() {
  const joined: string[] = [];
  const left: string[] = [];
  const emit = new Map<string, (event: string) => void>();
  const toWindow: Array<[string, string]> = [];
  const manager = new RealtimeManager(
    (topic, onEvent) => {
      joined.push(topic);
      emit.set(topic, onEvent);
      return () => void left.push(topic);
    },
    (topic, event) => void toWindow.push([topic, event]),
  );
  return { manager, joined, left, toWindow, emit: (topic: string, event: string) => emit.get(topic)?.(event) };
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
    expect(t.manager.size()).toBe(0);
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
});
