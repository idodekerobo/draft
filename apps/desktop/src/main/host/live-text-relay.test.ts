import { describe, expect, it } from "bun:test";
import type { LiveTextChunk } from "draft-core/live-sessions";
import { LiveTextRelay } from "./live-text-relay";

function setup(options: { enabled?: () => boolean } = {}) {
  const sent: LiveTextChunk[] = [];
  const timers = new Map<number, { ms: number; run: () => void }>();
  let next = 0;
  const relay = new LiveTextRelay({
    send: (chunk) => void sent.push(chunk),
    enabled: options.enabled,
    schedule: (run, ms) => {
      const id = ++next;
      timers.set(id, { ms, run });
      return id;
    },
    cancel: (handle) => void timers.delete(handle as number),
  });
  const fire = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.run();
    }
  };
  return { relay, sent, timers, fire };
}

describe("LiveTextRelay", () => {
  it("joins pushes that come within 50 ms into one chunk", () => {
    const t = setup();
    t.relay.push("m", "he", false);
    t.relay.push("m", "llo", false);
    expect(t.sent).toEqual([]);
    expect([...t.timers.values()].map((timer) => timer.ms)).toEqual([50]);
    t.fire();
    expect(t.sent).toEqual([{ messageId: "m", index: 0, text: "hello", final: false }]);
  });

  it("sends at once, in two chunks, when the text reaches 8000 characters", () => {
    const t = setup();
    t.relay.push("m", "x".repeat(9000), false);
    expect(t.sent.map((c) => [c.text.length, c.index, c.final])).toEqual([
      [8000, 0, false],
      [1000, 1, false],
    ]);
  });

  it("sends a final push at once with final true", () => {
    const t = setup();
    t.relay.push("m", "a", false);
    t.relay.push("m", "b", true);
    expect(t.sent).toEqual([{ messageId: "m", index: 0, text: "ab", final: true }]);
    expect(t.timers.size).toBe(0);
  });

  it("sends an empty final chunk when the message had text before and none is left", () => {
    const t = setup();
    t.relay.push("m", "hi", false);
    t.fire();
    t.relay.push("m", "", true);
    expect(t.sent.slice(1)).toEqual([{ messageId: "m", index: 1, text: "", final: true }]);
  });

  it("sends nothing for a message that never had text", () => {
    const t = setup();
    t.relay.push("m", "", true);
    expect(t.sent).toEqual([]);
  });

  it("keeps a separate index for each message", () => {
    const t = setup();
    t.relay.push("a", "one", false);
    t.fire();
    t.relay.push("b", "two", false);
    t.fire();
    t.relay.push("a", "three", true);
    expect(t.sent.map((c) => [c.messageId, c.index, c.text, c.final])).toEqual([
      ["a", 0, "one", false],
      ["b", 0, "two", false],
      ["a", 1, "three", true],
    ]);
  });

  it("does nothing when disabled", () => {
    const t = setup({ enabled: () => false });
    t.relay.push("m", "hello", true);
    t.fire();
    expect(t.sent).toEqual([]);
  });

  it("stop cancels the pending timers and forgets the text", () => {
    const t = setup();
    t.relay.push("m", "a", false);
    t.relay.stop();
    expect(t.timers.size).toBe(0);
    t.fire();
    expect(t.sent).toEqual([]);
  });
});
