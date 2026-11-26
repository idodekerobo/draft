import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EmbeddedAgentAdapter, EmbeddedAgentFactory, EmbeddedEvent } from "../../embedded-agent/adapter";

const OWNER = "33333333-3333-4333-8333-333333333333";
const input = (text: string) => ({ text, authorUserId: OWNER });

/** Reads events until `done` says enough, or fails after a second. */
export async function collect(agent: EmbeddedAgentAdapter, done: (events: EmbeddedEvent[]) => boolean, afterSeq = 0): Promise<EmbeddedEvent[]> {
  const events: EmbeddedEvent[] = [];
  const reading = (async () => {
    for await (const event of agent.events(afterSeq)) {
      events.push(event);
      if (done(events)) return;
    }
  })();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${events.length} events`)), 1000));
  await Promise.race([reading, timeout]);
  return events;
}

export const kinds = (events: EmbeddedEvent[]) => events.map((event) => event.body.kind);
export const settledFor = (requestId: string) => (events: EmbeddedEvent[]) =>
  events.some((event) => event.body.kind === "turn_settled" && event.body.requestId === requestId);

/**
 * What every embedded agent adapter must do, whatever the engine. The fake runs it now; the pi adapter runs it when it exists.
 * `scripts.plainReply` is a message that makes the agent answer in text; `scripts.hold` makes a turn that runs until interrupted.
 */
export function describeEmbeddedAgentContract(name: string, factory: EmbeddedAgentFactory, scripts: { plainReply: string; hold: string }) {
  describe(`${name}: the embedded agent contract`, () => {
    let agent: EmbeddedAgentAdapter;
    beforeEach(async () => {
      agent = factory({ storageScope: "contract-test" });
      await agent.open();
    });
    afterEach(async () => {
      await agent.close();
    });

    it("answers a message with the person's message, a reply and a settled turn, in committed order", async () => {
      await agent.submit(input(scripts.plainReply), "req-1");
      const events = await collect(agent, settledFor("req-1"));
      expect(kinds(events)).toEqual(["user_message", "assistant_text", "turn_settled"]);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(events[0]!.body).toMatchObject({ requestId: "req-1", authorUserId: OWNER });
      expect(events[2]!.body).toMatchObject({ outcome: "completed" });
      expect(new Set(events.map((event) => event.sourceId)).size).toBe(events.length);
    });

    it("takes a request id once: a second submit returns the first receipt and runs nothing", async () => {
      const first = await agent.submit(input(scripts.plainReply), "req-1");
      const second = await agent.submit(input(scripts.plainReply), "req-1");
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ requestId: "req-1", duplicate: true });
      const events = await collect(agent, settledFor("req-1"));
      expect(events.filter((event) => event.body.kind === "user_message")).toHaveLength(1);
    });

    it("lets a reader resume after the last event it saw", async () => {
      await agent.submit(input(scripts.plainReply), "req-1");
      await collect(agent, settledFor("req-1"));
      await agent.submit(input(scripts.plainReply), "req-2");
      const later = await collect(agent, settledFor("req-2"), 3);
      expect(later.map((event) => event.seq)).toEqual([4, 5, 6]);
    });

    it("stops a running turn on interrupt, once per control id", async () => {
      await agent.submit(input(scripts.hold), "req-1");
      expect(await agent.interrupt("stop-1")).toEqual({ controlId: "stop-1", applied: true });
      expect(await agent.interrupt("stop-1")).toEqual({ controlId: "stop-1", applied: true });
      const events = await collect(agent, settledFor("req-1"));
      expect(events.filter((event) => event.body.kind === "turn_settled")).toHaveLength(1);
      expect(events.at(-1)!.body).toMatchObject({ outcome: "interrupted" });
    });

    it("says an interrupt did nothing when nothing is running", async () => {
      expect(await agent.interrupt("stop-1")).toMatchObject({ applied: false, reason: "idle" });
    });

    it("applies a model change for the next request, once per control id", async () => {
      const model = { provider: "anthropic", model: "claude-test" };
      expect(await agent.setModel("model-1", model)).toEqual({ controlId: "model-1", applied: true });
      expect(await agent.setModel("model-1", { provider: "x", model: "y" })).toEqual({ controlId: "model-1", applied: true });
      await agent.submit(input(scripts.plainReply), "req-1");
      const events = await collect(agent, settledFor("req-1"));
      expect(events.find((event) => event.body.kind === "assistant_text")!.body).toMatchObject({ model });
    });

    it("refuses work after it is closed, and closing twice is fine", async () => {
      await agent.close();
      await agent.close();
      await expect(agent.submit(input("hello"), "req-1")).rejects.toThrow();
    });

    it("finishes an events stream when the agent closes", async () => {
      const reading = collect(agent, () => false);
      await agent.close();
      expect(await reading).toEqual([]);
    });
  });
}
