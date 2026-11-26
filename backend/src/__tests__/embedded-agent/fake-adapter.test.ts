import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeEmbeddedAgent, fakeEmbeddedAgentFactory } from "../../embedded-agent/fake-adapter";
import { collect, describeEmbeddedAgentContract, kinds, settledFor } from "./contract";

const OWNER = "33333333-3333-4333-8333-333333333333";
const input = (text: string) => ({ text, authorUserId: OWNER });

describeEmbeddedAgentContract("the fake adapter", fakeEmbeddedAgentFactory, { plainReply: "hello", hold: "hold: work" });

describe("the fake adapter's scripts", () => {
  let agent: FakeEmbeddedAgent;
  beforeEach(async () => {
    agent = new FakeEmbeddedAgent();
    await agent.open();
  });
  afterEach(() => agent.close());

  it("echoes a plain message, and says what follows reply:", async () => {
    await agent.submit(input("hello"), "r1");
    await agent.submit(input("reply: Done."), "r2");
    const events = await collect(agent, settledFor("r2"));
    expect(events.filter((event) => event.body.kind === "assistant_text").map((event) => (event.body as { text: string }).text)).toEqual(["echo: hello", "Done."]);
  });

  it("registers under the pi adapter id", () => {
    expect(agent.adapterId).toBe("pi-durable-sdk");
  });

  it("waits on ask:, and an answer resumes the turn once per answer", async () => {
    await agent.submit(input("ask: Send it now?"), "r1");
    const waiting = await collect(agent, (events) => events.some((event) => event.body.kind === "permission_request"));
    expect(waiting.at(-1)!.body).toMatchObject({ toolCallId: "call-r1", requestKind: "question", questions: [{ question: "Send it now?" }] });

    const answer = { inputId: "input-1", decision: "allow" as const };
    expect(await agent.answer("call-r1", answer)).toEqual({ controlId: "input-1", applied: true });
    expect(await agent.answer("call-r1", answer)).toEqual({ controlId: "input-1", applied: true });
    const events = await collect(agent, settledFor("r1"));
    expect(kinds(events)).toEqual(["user_message", "permission_request", "permission_resolved", "assistant_text", "turn_settled"]);
  });

  it("refuses an answer to something that is not waiting", async () => {
    expect(await agent.answer("call-none", { inputId: "input-1", decision: "allow" })).toMatchObject({ applied: false, reason: "not_waiting" });
  });

  it("closes a question with cancelled when its turn is interrupted", async () => {
    await agent.submit(input("ask: Proceed?"), "r1");
    await agent.interrupt("stop-1");
    const events = await collect(agent, settledFor("r1"));
    expect(events.find((event) => event.body.kind === "permission_resolved")!.body).toMatchObject({ decision: "cancelled" });
    expect(events.at(-1)!.body).toMatchObject({ outcome: "interrupted" });
  });

  it("settles a failed turn with its reason", async () => {
    await agent.submit(input("fail: model unavailable"), "r1");
    const events = await collect(agent, settledFor("r1"));
    expect(events.at(-1)!.body).toMatchObject({ outcome: "failed", reason: "model unavailable" });
  });

  it("sends the reply as live text before it commits", async () => {
    const parts: Array<{ text: string; done: boolean }> = [];
    const reading = (async () => {
      for await (const part of agent.liveText()) {
        parts.push(part);
        if (part.done) return;
      }
    })();
    await agent.submit(input("hello"), "r1");
    await reading;
    expect(parts.at(-1)).toMatchObject({ text: "echo: hello", done: true });
  });
});
