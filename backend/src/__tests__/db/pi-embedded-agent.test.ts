import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { EmbeddedAgentContext } from "../../embedded-agent/adapter";
import { createPiAgentFactory } from "../../embedded-agent/pi/adapter";
import { collect, describeEmbeddedAgentContract, kinds, setCollectTimeout, settledFor } from "../embedded-agent/contract";
import { embeddedAgentDb } from "./embedded-agent-fixture";

// The pi adapter on staging Postgres, with pi's scripted model: the shared contract every adapter passes, then what is pi's own.
const { describeWithDatabase, pool, db, createWorkspace } = embeddedAgentDb;
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

/** A backend session with a claim, for one test. Gives the context the host would, and removes everything after. */
async function homeContext(): Promise<{ context: EmbeddedAgentContext; cleanup: () => Promise<void>; sessionId: string }> {
  const { workspaceId } = await createWorkspace();
  const userId = randomUUID();
  await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
  const [w] = await db()<[{ organization_id: string; team_id: string }]>`select organization_id, team_id from workspaces where id = ${workspaceId}`;
  await db()`update users set organization_id = ${w.organization_id}, primary_team_id = ${w.team_id}, status = 'active' where id = ${userId}`;
  const [session] = await db()<[{ id: string }]>`
    insert into sessions (workspace_id, owner_user_id, host_id, is_home, execution_target, adapter_id)
    values (${workspaceId}, ${userId}, ${`backend:${randomUUID()}`}, true, 'backend', 'pi-durable-sdk') returning id`;
  const owner = `test-${randomUUID()}`;
  const [{ claim }] = await db()<[{ claim: { epoch: number } }]>`select claim_embedded_agent(${session.id}, ${owner}, '10 minutes'::interval) as claim`;
  const context: EmbeddedAgentContext = {
    sessionId: session.id, workspaceId, ownerUserId: userId, owner, epoch: Number(claim.epoch), instructions: "You are Home.",
    assertOwner: () => {}, stillOwner: async () => true, currentRun: async () => { throw new Error("no run in this test"); },
  };
  return { context, sessionId: session.id, cleanup: async () => { await db()`delete from sessions where id = ${session.id}`; await db()`delete from auth.users where id = ${userId}`; } };
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
});
