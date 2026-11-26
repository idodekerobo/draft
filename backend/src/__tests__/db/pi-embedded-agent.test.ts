import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import { callerRun } from "draft-core/tools";
import { z } from "zod";
import { createPiAgentFactory } from "../../embedded-agent/pi/adapter";
import { createHomeTools } from "../../home/tools";
import { buildHomeRunSpec } from "../../home/runtime/spec";
import { ToolRegistry, type RegisteredTool } from "../../metaharness/tools/tool-registry";
import { collect, describeEmbeddedAgentContract, kinds, setCollectTimeout, settledFor } from "../embedded-agent/contract";
import { embeddedAgentDb, homeContext } from "./embedded-agent-fixture";

// The pi adapter on staging Postgres, with pi's scripted model: the shared contract every adapter passes, then what is pi's own.
const { describeWithDatabase, pool } = embeddedAgentDb;
const OWNER_INPUT = (text: string) => ({ text, authorUserId: "33333333-3333-4333-8333-333333333333" });

/** A scripted model that says "Reply: <text>", or never answers when asked to hold. */
function scriptedModel(): { faux: FauxProviderHandle; steps: FauxResponseStep[] } {
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 400 });
  const respond: FauxResponseStep = (context, options, _state, model) => {
    const last = [...context.messages].reverse().find((message) => message.role === "user");
    const text = typeof last?.content === "string" ? last.content : Array.isArray(last?.content) ? (last!.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("") : "";
    if (text.startsWith("hold:")) {
      return new Promise((_, reject) => {
        const signal = options!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return { ...fauxAssistantMessage(`Reply: ${text}`), provider: model.provider, model: model.id };
  };
  return { faux, steps: Array.from({ length: 60 }, () => respond) };
}

describeWithDatabase("the pi embedded agent", () => {
  setCollectTimeout(25_000);
  const { faux, steps } = scriptedModel();
  const models = createModels();
  models.setProvider(faux.provider);
  const factory = createPiAgentFactory({ pool: pool(), models, defaultModel: { provider: "faux", model: "faux-1" } });
  // The faux provider's scripted steps are shared, so each test starts with a full script.
  const refill = () => faux.setResponses([...steps]);

  describeEmbeddedAgentContract("pi", (context) => { refill(); return factory(context); }, { plainReply: "hello", hold: "hold: work", model: { provider: "faux", model: "faux-2" } }, async () => {
    const made = await homeContext();
    return { context: made.context, cleanup: made.cleanup };
  });

  describe("beyond the contract", () => {
    it("writes what it did to the outbox in the same commit, in order, under stable source ids", async () => {
      const made = await homeContext();
      refill();
      const agent = factory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("hello"), "in-1");
      await collect(agent, settledFor("in-1"));
      const { rows } = await pool().query(`select key, payload->'event'->'body'->>'kind' as kind from embedded_agent_state where session_id = $1 and kind = 'outbox' order by seq, (payload->>'ordinal')::int`, [made.sessionId]);
      expect(rows.map((row) => row.kind)).toEqual(["user_message", "assistant_text", "turn_settled"]);
      expect(rows[0].key).toBe("req:in-1");
      await agent.close();
      await made.cleanup();
    });

    it("resumes after a reopen without answering the same request twice", async () => {
      const made = await homeContext();
      refill();
      const first = factory(made.context);
      await first.open();
      await first.submit(OWNER_INPUT("hello"), "in-1");
      await collect(first, settledFor("in-1"));
      await first.close();

      const second = factory(made.context);
      await second.open();
      const again = await second.submit(OWNER_INPUT("hello"), "in-1");
      expect(again.duplicate).toBe(true);
      const events = await collect(second, settledFor("in-1"));
      expect(kinds(events).filter((kind) => kind === "assistant_text")).toHaveLength(1);
      await second.close();
      await made.cleanup();
    });
  });

  describe("asking the person a question", () => {
    /** First asks, then says what the answer was. */
    const asking = (): FauxResponseStep[] => {
      const step: FauxResponseStep = (context, _options, _state, model) => {
        const last = context.messages.at(-1);
        const base = { provider: model.provider, model: model.id };
        if (last?.role === "toolResult") {
          const text = (last.content as Array<{ text?: string }>).map((block) => block.text ?? "").join(" ");
          return { ...fauxAssistantMessage(`Noted. ${text}`), ...base };
        }
        return { ...fauxAssistantMessage([fauxToolCall("home_ask", { question: "Send it now?" }, { id: "ask-1" })], { stopReason: "toolUse" }), ...base };
      };
      return Array.from({ length: 10 }, () => step);
    };

    it("shows the question, waits without holding a run, and carries the answer back to the tool", async () => {
      const made = await homeContext();
      faux.setResponses(asking());
      const agent = factory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("please send it"), "in-1");
      const waiting = await collect(agent, (events) => events.some((event) => event.body.kind === "permission_request"));
      expect(waiting.find((event) => event.body.kind === "permission_request")!.body).toMatchObject({ toolCallId: "ask-1", requestKind: "question", questions: [{ question: "Send it now?" }] });
      expect(waiting.some((event) => event.body.kind === "turn_settled")).toBe(false);

      const outcome = await agent.answer("ask-1", { inputId: "answer-1", decision: "allow", answers: { "Send it now?": "yes, now" } });
      expect(outcome).toMatchObject({ applied: true });
      expect(await agent.answer("ask-1", { inputId: "answer-1", decision: "allow" })).toMatchObject({ applied: true });
      expect(await agent.answer("ask-1", { inputId: "answer-2", decision: "deny" })).toMatchObject({ applied: false, reason: "not_waiting" });

      const events = await collect(agent, settledFor("in-1"));
      const bodies = events.map((event) => event.body);
      expect(bodies.find((body) => body.kind === "permission_resolved")).toMatchObject({ toolCallId: "ask-1", decision: "allow" });
      expect(bodies.find((body) => body.kind === "assistant_text")).toMatchObject({ text: expect.stringContaining("yes, now") });
      expect(bodies.at(-1)).toMatchObject({ kind: "turn_settled", outcome: "completed" });
      await agent.close();
      await made.cleanup();
    });

    it("closes the question as cancelled when the turn is stopped", async () => {
      const made = await homeContext();
      faux.setResponses(asking());
      const agent = factory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("please send it"), "in-1");
      await collect(agent, (events) => events.some((event) => event.body.kind === "permission_request"));
      expect(await agent.interrupt("stop-1")).toMatchObject({ applied: true });
      const events = await collect(agent, settledFor("in-1"));
      expect(events.find((event) => event.body.kind === "permission_resolved")!.body).toMatchObject({ toolCallId: "ask-1", decision: "cancelled" });
      expect(events.at(-1)!.body).toMatchObject({ outcome: "interrupted" });
      await agent.close();
      await made.cleanup();
    });

    it("still shows a waiting question after the agent is reopened, and the answer still resumes it", async () => {
      const made = await homeContext();
      faux.setResponses(asking());
      const first = factory(made.context);
      await first.open();
      await first.submit(OWNER_INPUT("please send it"), "in-1");
      await collect(first, (events) => events.some((event) => event.body.kind === "permission_request"));
      await first.close();

      faux.setResponses(asking());
      const second = factory(made.context);
      await second.open();
      expect(await second.answer("ask-1", { inputId: "answer-1", decision: "allow" })).toMatchObject({ applied: true });
      const events = await collect(second, settledFor("in-1"));
      expect(events.at(-1)!.body).toMatchObject({ outcome: "completed" });
      expect(events.filter((event) => event.body.kind === "permission_request")).toHaveLength(1);
      await second.close();
      await made.cleanup();
    });
  });

  describe("Draft's tools", () => {
    const calls: Array<{ tool: string; approvedBy: string | undefined; hasRun: boolean; args: unknown }> = [];
    const fakeTool = (name: string, access: "read" | "write", extra: Partial<RegisteredTool> = {}): RegisteredTool => ({
      name, access, description: `${name} for tests`, allowedOrigins: ["person"], mcp: false, modelVisible: true, destructive: false,
      inputSchema: z.object({ personId: z.string().optional() }),
      parse: (raw) => ({ ok: true, value: raw }), permission: () => ({}), checkLimits: () => null, auditArguments: (value) => value as Record<string, unknown>,
      run: async (caller, value) => { calls.push({ tool: name, approvedBy: caller.approvedBy, hasRun: callerRun(caller) !== null, args: value }); return { status: "ok", output: { done: name } }; },
      ...extra,
    });
    const registry = new ToolRegistry([fakeTool("home.needs_you", "read"), fakeTool("people.approve", "write")]);
    const homeFactory = createPiAgentFactory({
      pool: pool(), models, defaultModel: { provider: "faux", model: "faux-1" },
      tools: (context, gate) => createHomeTools({ tools: registry.list(), invoke: { registry, audit: async () => {}, authorizeUser: async () => null }, context, gate }),
    });
    const contextWithRun = async () => {
      const made = await homeContext();
      const spec = buildHomeRunSpec({ runId: randomUUID(), workspaceId: made.context.workspaceId, ownerUserId: made.context.ownerUserId, sessionId: made.sessionId, model: null, contextVersionId: randomUUID(), instructions: "" });
      return { ...made, context: { ...made.context, currentRun: async () => spec } };
    };
    /** Calls one tool, then says what the result was. */
    const calling = (tool: string, args: object): FauxResponseStep[] => {
      const step: FauxResponseStep = (context, _options, _state, model) => {
        const last = context.messages.at(-1);
        const base = { provider: model.provider, model: model.id };
        if (last?.role === "toolResult") return { ...fauxAssistantMessage(`Result: ${(last.content as Array<{ text?: string }>).map((b) => b.text ?? "").join(" ")}`), ...base };
        return { ...fauxAssistantMessage([fauxToolCall(tool, args as never, { id: "call-1" })], { stopReason: "toolUse" }), ...base };
      };
      return Array.from({ length: 10 }, () => step);
    };

    it("runs a read tool as the owner, through Home's run, and shows the call and its result", async () => {
      calls.length = 0;
      const made = await contextWithRun();
      faux.setResponses(calling("home_needs_you", {}));
      const agent = homeFactory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("what needs me?"), "in-1");
      const events = await collect(agent, settledFor("in-1"));
      expect(calls).toEqual([{ tool: "home.needs_you", approvedBy: undefined, hasRun: true, args: {} }]);
      expect(kinds(events)).toEqual(["user_message", "tool_use", "tool_result", "assistant_text", "turn_settled"]);
      expect(events.find((event) => event.body.kind === "tool_result")!.body).toMatchObject({ content: '{"done":"home.needs_you"}', isError: false });
      await agent.close();
      await made.cleanup();
    });

    it("waits for a card before a tool that changes access, and runs it only after the person allows it", async () => {
      calls.length = 0;
      const made = await contextWithRun();
      faux.setResponses(calling("people_approve", { personId: "p1" }));
      const agent = homeFactory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("approve Pat"), "in-1");
      const waiting = await collect(agent, (events) => events.some((event) => event.body.kind === "permission_request"));
      expect(waiting.find((event) => event.body.kind === "permission_request")!.body).toMatchObject({ toolCallId: "call-1", requestKind: "approval", name: "people.approve", input: { personId: "p1" } });
      expect(calls).toEqual([]);

      await agent.answer("call-1", { inputId: "answer-1", decision: "allow" });
      const events = await collect(agent, settledFor("in-1"));
      expect(calls).toEqual([{ tool: "people.approve", approvedBy: made.context.ownerUserId, hasRun: true, args: { personId: "p1" } }]);
      expect(events.at(-1)!.body).toMatchObject({ outcome: "completed" });
      await agent.close();
      await made.cleanup();
    });

    it("does nothing when the person says no, and tells the model so", async () => {
      calls.length = 0;
      const made = await contextWithRun();
      faux.setResponses(calling("people_approve", { personId: "p1" }));
      const agent = homeFactory(made.context);
      await agent.open();
      await agent.submit(OWNER_INPUT("approve Pat"), "in-1");
      await collect(agent, (events) => events.some((event) => event.body.kind === "permission_request"));
      await agent.answer("call-1", { inputId: "answer-1", decision: "deny" });
      const events = await collect(agent, settledFor("in-1"));
      expect(calls).toEqual([]);
      expect(events.find((event) => event.body.kind === "assistant_text")!.body).toMatchObject({ text: expect.stringContaining("did not approve") });
      await agent.close();
      await made.cleanup();
    });
  });

  describe("live text", () => {
    it("sends the start of the reply as pieces, then marks it done; the committed message carries the whole", async () => {
      const slow = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 40 });
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(5).trim();
      slow.setResponses([(_context, _options, _state, model) => ({ ...fauxAssistantMessage(text), provider: model.provider, model: model.id })]);
      const slowModels = createModels();
      slowModels.setProvider(slow.provider);
      const made = await homeContext();
      const agent = createPiAgentFactory({ pool: pool(), models: slowModels, defaultModel: { provider: "faux", model: "faux-1" } })(made.context);
      await agent.open();
      const parts: Array<{ text: string; done: boolean }> = [];
      const reading = (async () => {
        for await (const part of agent.liveText()) {
          parts.push(part);
          if (part.done) return;
        }
      })();
      await agent.submit(OWNER_INPUT("go"), "in-1");
      await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error("no live text")), 30_000))]);
      await collect(agent, settledFor("in-1"));
      expect(parts.length).toBeGreaterThan(2);
      expect(parts.at(-1)).toMatchObject({ text: "", done: true });
      // pi throttles partials, so the pieces may stop short of the end. They are provisional: the committed message is the record.
      const joined = parts.map((part) => part.text).join("");
      expect(joined.length).toBeGreaterThan(0);
      expect(text.startsWith(joined)).toBe(true);
      await agent.close();
      await made.cleanup();
    });
  });
});
