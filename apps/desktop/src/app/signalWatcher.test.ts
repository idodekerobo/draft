import { describe, expect, it } from "bun:test";
import { createWindowSignalWatcher } from "./signalWatcher";

function setup() {
  const sent: string[][] = [];
  let push: (topic: string, event: string, payload?: unknown) => void = () => {};
  let pushConnection: (connected: boolean) => void = () => {};
  const { watch, watchConnection } = createWindowSignalWatcher({
    setTopics: (topics) => void sent.push(topics),
    onSignal: (handler) => {
      push = handler;
      return () => {};
    },
    onConnection: (handler) => {
      pushConnection = handler;
      return () => {};
    },
  });
  return { watch, watchConnection, sent, push: (topic: string, event: string, payload?: unknown) => push(topic, event, payload), pushConnection: (connected: boolean) => pushConnection(connected) };
}
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("createWindowSignalWatcher", () => {
  it("starts by sending an empty list, so main drops what the page before it held", async () => {
    const t = setup();
    await tick();
    expect(t.sent).toEqual([[]]);
  });

  it("sends the whole list once for several watchers that mount together", async () => {
    const t = setup();
    t.watch("a", () => {});
    t.watch("b", () => {});
    await tick();
    expect(t.sent).toEqual([[], ["a", "b"]]);
  });

  it("shares a topic between listeners, sends again only when the list changes, and routes signals by topic", async () => {
    const t = setup();
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = t.watch("a", (event) => first.push(event));
    const stopSecond = t.watch("a", (event) => second.push(event));
    await tick();
    t.push("a", "events");
    t.push("b", "events");
    expect([first, second]).toEqual([["events"], ["events"]]);
    stopFirst();
    await tick();
    expect(t.sent).toEqual([[], ["a"]]);
    stopSecond();
    await tick();
    expect(t.sent).toEqual([[], ["a"], []]);
  });

  it("passes the payload of a signal to the listeners of its topic", () => {
    const t = setup();
    const seen: Array<[string, unknown]> = [];
    t.watch("live:session:s1", (event, payload) => seen.push([event, payload]));
    t.push("live:session:s1", "text", { messageId: "m1", index: 0, text: "Hi", final: false });
    t.push("live:session:s1", "events");
    expect(seen).toEqual([
      ["text", { messageId: "m1", index: 0, text: "Hi", final: false }],
      ["events", undefined],
    ]);
  });

  it("assumes the connection is fine until main says otherwise, then follows what main says", () => {
    const t = setup();
    const states: boolean[] = [];
    t.watchConnection((connected) => states.push(connected));
    t.pushConnection(false);
    t.pushConnection(true);
    expect(states).toEqual([true, false, true]);
  });
});
