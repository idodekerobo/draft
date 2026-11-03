import { describe, expect, it } from "bun:test";
import type { HostEvent } from "./approvals";
import { LeadInRelay } from "./lead-in";

function setup() {
  const posted: HostEvent[] = [];
  const clock = { now: 1_000 };
  const relay = new LeadInRelay(async (events) => void posted.push(...events), () => clock.now);
  const say = (id: string, ...chunks: string[]) => chunks.forEach((delta, index) => relay.message({ message_id: id, index, final: index === chunks.length - 1, delta }));
  return { relay, posted, clock, say };
}

describe("LeadInRelay", () => {
  it("posts a message that ends in a request, once, as an early copy", () => {
    const { relay, posted, say } = setup();
    relay.requestOpened();
    say("m1", "I will run ", "the tests.");
    expect(posted).toEqual([{ sourceId: "lead:m1", kind: "assistant_text", payload: { text: "I will run the tests.", preview: true } }]);
  });

  it("posts a message that finished just before its request opened", () => {
    const { relay, posted, clock, say } = setup();
    say("m1", "Which one?");
    expect(posted).toEqual([]);
    clock.now += 500;
    relay.requestOpened();
    expect(posted).toHaveLength(1);
    relay.requestOpened();
    expect(posted).toHaveLength(1);
  });

  it("never posts a message that no request waits on, or one that is too old", () => {
    const { relay, posted, clock, say } = setup();
    say("m1", "Plain reply.");
    clock.now += 60_000;
    relay.requestOpened();
    expect(posted).toEqual([]);
    relay.requestClosed();
    say("m2", "Another plain reply.");
    expect(posted).toEqual([]);
  });

  it("joins chunks in order, ignores empty text, and waits for the final chunk", () => {
    const { relay, posted } = setup();
    relay.requestOpened();
    relay.message({ message_id: "m1", index: 0, final: false, delta: "hello " });
    expect(posted).toHaveLength(0);
    relay.message({ message_id: "m1", index: 1, final: true, delta: "world" });
    expect(posted).toHaveLength(1);
    expect((posted[0]!.payload as { text: string }).text).toBe("hello world");
    relay.message({ message_id: "m2", index: 0, final: true, delta: "   " });
    relay.message({ message_id: "m3", index: 0, final: false, delta: "partial" });
    relay.message({ index: 0, final: true, delta: "no id" });
    expect(posted).toHaveLength(1);
  });
});
