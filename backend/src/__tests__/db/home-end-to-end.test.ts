import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createPiAgentFactory } from "../../embedded-agent/pi/adapter";
import { serviceClient } from "../../db/client";
import { HomeHost } from "../../home/runtime/host";
import { projectOutbox } from "../../home/runtime/project";
import { openHomeRun, settleHomeRun } from "../../home/runtime/runs";
import { createHostStore } from "../../home/runtime/store";
import { HOME_ADAPTER_ID } from "../../home/runtime/spec";
import type { WakeBus } from "../../home/runtime/ports";
import { createHomeTools } from "../../home/tools";
import { ToolRegistry, type RegisteredTool } from "../../metaharness/tools/tool-registry";
import { embeddedAgentDb, withFixtureStorage, type Fixture } from "./embedded-agent-fixture";

// Everything together on staging, with pi's scripted model: a saved input becomes a reply in the transcript, a question
// becomes a card whose answer resumes the turn, and the run opens and ends. The real host, store, projector and run functions.
const { describeWithDatabase, pool } = embeddedAgentDb;

const noBus: WakeBus = { notify: async () => {}, listen: () => () => {} };
const ownerCalls: string[] = [];
const registry = new ToolRegistry([
  {
    name: "home.needs_you", access: "read", description: "How many things need the person", allowedOrigins: ["person"], mcp: false, modelVisible: true, destructive: false,
    inputSchema: z.object({}), parse: (raw) => ({ ok: true, value: raw }), permission: () => ({}), checkLimits: () => null, auditArguments: (v) => v as Record<string, unknown>,
    run: async () => (ownerCalls.push("needs_you"), { status: "ok", output: { count: 2 } }),
  } as RegisteredTool,
]);

function homeHost() {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const script = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
  const factory = createPiAgentFactory({
    pool: pool(), models, defaultModel: { provider: "faux", model: "faux-1" },
    tools: (context, gate) => createHomeTools({ tools: registry.list(), invoke: { registry, audit: async () => {}, authorizeUser: async () => null }, context, gate }),
  });
  const host = new HomeHost({
    store: createHostStore({ pool: pool(), client: serviceClient }),
    bus: noBus,
    runs: { open: (session, instructions) => openHomeRun(serviceClient, session, instructions), settle: (sessionId, runId) => settleHomeRun(serviceClient, sessionId, runId) },
    factory,
    project: async (session) => {
      const settled: Array<{ requestId: string; outcome: string }> = [];
      await projectOutbox({ pool: pool(), client: serviceClient, adapterId: HOME_ADAPTER_ID, onSettled: (rows) => void settled.push(...rows) }, { id: session.id, workspaceId: session.workspaceId });
      return settled;
    },
    owner: `e2e-${randomUUID()}`,
    instructions: () => "You are Home.",
    claimTtlSeconds: 60,
  });
  return { host, script };
}

const say = (text: string): FauxResponseStep => (_context, _options, _state, model) => ({ ...fauxAssistantMessage(text), provider: model.provider, model: model.id });
const ask = (): FauxResponseStep => (_context, _options, _state, model) => ({ ...fauxAssistantMessage([fauxToolCall("home_ask", { question: "Send it now?" }, { id: "ask-1" })], { stopReason: "toolUse" }), provider: model.provider, model: model.id });
const callTool = (name: string): FauxResponseStep => (_context, _options, _state, model) => ({ ...fauxAssistantMessage([fauxToolCall(name, {}, { id: "call-1" })], { stopReason: "toolUse" }), provider: model.provider, model: model.id });

async function addInput(f: Fixture, kind: string, payload: object): Promise<string> {
  const { rows } = await pool().query(`insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload) values ($1, $2, $3, 'Owner', $4, $5::jsonb) returning id`, [f.sessionId, f.workspaceId, f.userId, kind, JSON.stringify(payload)]);
  return rows[0].id as string;
}
const events = async (f: Fixture) => (await pool().query(`select seq::int as seq, kind, source_id, payload from session_events where session_id = $1 order by seq`, [f.sessionId])).rows;
const input = async (id: string) => (await pool().query(`select state, consumed_seq::int as consumed_seq from session_inputs where id = $1`, [id])).rows[0];
const runs = async (f: Fixture) => (await pool().query(`select status from agent_runs where session_id = $1 order by created_at`, [f.sessionId])).rows.map((r) => r.status as string);

async function until(check: () => Promise<boolean>, what: string, ms = 40_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describeWithDatabase("Home, end to end", () => {
  it("turns a saved message into a reply in the transcript, settles the input, and opens then ends one run", () =>
    withFixtureStorage(async (_storage, f) => {
      // The fixture already claimed the Home for its own storage. Release it so the host can claim.
      await pool().query(`select release_embedded_agent($1, $2, $3)`, [f.sessionId, f.owner, f.epoch]);
      const { host, script } = homeHost();
      script(say("Hello, this is Home."));
      const id = await addInput(f, "message", { text: "hi Home" });
      expect(await host.deliver(f.sessionId)).toBe(true);

      await until(async () => (await events(f)).some((e) => e.kind === "assistant_text"), "the reply");
      const rows = await events(f);
      expect(rows.map((r) => r.kind)).toEqual(["user_message", "assistant_text"]);
      expect(rows[1].payload).toMatchObject({ text: "Hello, this is Home.", author_label: "Draft agent", adapter_id: "pi-durable-sdk" });
      await until(async () => (await input(id)).state === "consumed", "the input to settle");
      expect((await input(id)).consumed_seq).toBe(1);
      await until(async () => (await runs(f)).at(-1) === "succeeded", "the run to end");
      expect(await runs(f)).toEqual(["succeeded"]);
      await host.stop();
    }));

  it("runs a Draft tool as the owner and shows the call and its result", () =>
    withFixtureStorage(async (_storage, f) => {
      await pool().query(`select release_embedded_agent($1, $2, $3)`, [f.sessionId, f.owner, f.epoch]);
      ownerCalls.length = 0;
      const { host, script } = homeHost();
      script(callTool("home_needs_you"), say("Two things need you."));
      await addInput(f, "message", { text: "what needs me?" });
      await host.deliver(f.sessionId);
      await until(async () => (await events(f)).some((e) => e.kind === "assistant_text"), "the answer");
      expect((await events(f)).map((r) => r.kind)).toEqual(["user_message", "tool_use", "tool_result", "assistant_text"]);
      expect(ownerCalls).toEqual(["needs_you"]);
      await host.stop();
    }));

  it("shows a question as a waiting card, counts it in Needs you, and resumes when the decision is saved", () =>
    withFixtureStorage(async (_storage, f) => {
      await pool().query(`select release_embedded_agent($1, $2, $3)`, [f.sessionId, f.owner, f.epoch]);
      const { host, script } = homeHost();
      script(ask(), say("Sent it."));
      await addInput(f, "message", { text: "send the update" });
      await host.deliver(f.sessionId);
      await until(async () => (await events(f)).some((e) => e.kind === "permission_request"), "the question");
      expect((await pool().query(`select open_approval_count::int as n from sessions where id = $1`, [f.sessionId])).rows[0].n).toBe(1);
      expect(await runs(f)).toEqual(["running"]);

      const decision = await addInput(f, "permission_decision", { requestId: "ask-1", decision: "allow", answers: { "Send it now?": "yes" } });
      await host.deliver(f.sessionId);
      await until(async () => (await events(f)).some((e) => e.kind === "assistant_text"), "the resumed reply");
      expect((await events(f)).map((r) => r.kind)).toEqual(["user_message", "permission_request", "permission_resolved", "assistant_text"]);
      expect((await events(f)).find((r) => r.kind === "permission_resolved")!.payload).toMatchObject({ requestId: "ask-1", reason: "decided", decision: "allow" });
      await until(async () => (await input(decision)).state === "consumed", "the decision to settle");
      expect((await pool().query(`select open_approval_count::int as n from sessions where id = $1`, [f.sessionId])).rows[0].n).toBe(0);
      await until(async () => (await runs(f)).at(-1) === "succeeded", "the run to end");
      await host.stop();
    }));

  it("finishes the work after the backend restarts, with no second answer", () =>
    withFixtureStorage(async (_storage, f) => {
      await pool().query(`select release_embedded_agent($1, $2, $3)`, [f.sessionId, f.owner, f.epoch]);
      const first = homeHost();
      first.script(say("Hello once."));
      await addInput(f, "message", { text: "hi" });
      await first.host.deliver(f.sessionId);
      await until(async () => (await events(f)).some((e) => e.kind === "assistant_text"), "the reply");
      await first.host.stop();

      // A new process: it finds the settled work, repeats nothing, and has no pending input.
      const second = homeHost();
      second.script(say("Hello twice."));
      await second.host.sweep();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect((await events(f)).filter((e) => e.kind === "assistant_text")).toHaveLength(1);
      await second.host.stop();
    }));
});
