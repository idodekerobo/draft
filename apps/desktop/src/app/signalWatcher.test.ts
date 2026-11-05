import { describe, expect, it } from "bun:test";
import { createWindowSignalWatcher } from "./signalWatcher";

function setup() {
  const sent: string[][] = [];
  let push: (topic: string, event: string) => void = () => {};
  const watch = createWindowSignalWatcher({
    setTopics: (topics) => void sent.push(topics),
    onSignal: (handler) => {
      push = handler;
      return () => {};
    },
  });
  return { watch, sent, push: (topic: string, event: string) => push(topic, event) };
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
});
