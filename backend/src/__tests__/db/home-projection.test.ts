import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddedEventBody } from "../../embedded-agent/adapter";
import { projectOutbox } from "../../home/runtime/project";
import { embeddedAgentDb, withFixtureStorage, type Fixture } from "./embedded-agent-fixture";

// The projector against real Postgres: outbox rows become transcript events in one transaction with their projected mark.
const { describeWithDatabase, pool } = embeddedAgentDb;

/** Answers the two calls the projector makes, straight on the database, so no API settings are needed. */
function shim(): SupabaseClient {
  const result = <T>(data: T) => Promise.resolve({ data, error: null });
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const { rows } = await pool().query(`select ${name}($1, $2, $3::jsonb, $4::text[]) as r`, [args.p_session_id, args.p_workspace_id, JSON.stringify(args.p_events), args.p_outbox_keys]);
        return { data: rows[0].r, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq"]) chain[method] = () => chain;
      chain.maybeSingle = () => result(null);
      return chain;
    },
  } as unknown as SupabaseClient;
}

let n = 0;
async function outbox(sessionId: string, key: string, body: EmbeddedEventBody, seq = ++n) {
  await pool().query(
    `insert into embedded_agent_state (session_id, kind, key, seq, payload) values ($1, 'outbox', $2, $3, $4::jsonb)`,
    [sessionId, key, seq, JSON.stringify({ ordinal: 0, event: { at: new Date().toISOString(), body } })],
  );
}
const events = async (f: Fixture) => (await pool().query(`select seq::int as seq, source_id, kind, payload from session_events where session_id = $1 order by seq`, [f.sessionId])).rows;
const session = async (f: Fixture) => (await pool().query(`select last_seq::int as last_seq, open_approval_count::int as approvals, status from sessions where id = $1`, [f.sessionId])).rows[0];
const pending = async (f: Fixture) => Number((await pool().query(`select count(*)::int as n from embedded_agent_state where session_id = $1 and kind = 'outbox' and projected_at is null`, [f.sessionId])).rows[0].n);
const deps = () => ({ pool: pool(), client: shim(), adapterId: "pi-durable-sdk" });

describeWithDatabase("projecting the outbox into session events", () => {
  it("copies rows in order, settles the person's message, counts a waiting question, and marks every row projected", () =>
    withFixtureStorage(async (_storage, f) => {
      const [input] = (await pool().query(`insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload) values ($1, $2, $3, 'Owner', 'message', '{"text":"hi"}') returning id`, [f.sessionId, f.workspaceId, f.userId])).rows;
      await outbox(f.sessionId, "req:1", { kind: "user_message", requestId: input.id, text: "hi", authorUserId: f.userId });
      await outbox(f.sessionId, "reply:1", { kind: "assistant_text", text: "Hello.", model: null });
      await outbox(f.sessionId, "ask:1", { kind: "permission_request", toolCallId: "call-1", requestKind: "question", name: "home.ask", input: {}, questions: [{ question: "Go?" }] });
      await outbox(f.sessionId, "settled:1", { kind: "turn_settled", requestId: input.id, outcome: "completed" });

      const settled: unknown[] = [];
      expect(await projectOutbox({ ...deps(), onSettled: (s) => void settled.push(...s) }, { id: f.sessionId, workspaceId: f.workspaceId })).toBe(4);

      const rows = await events(f);
      expect(rows.map((r) => [r.seq, r.kind, r.source_id])).toEqual([[1, "user_message", "req:1"], [2, "assistant_text", "reply:1"], [3, "permission_request", "perm:call-1"]]);
      expect(await session(f)).toMatchObject({ last_seq: 3, approvals: 1, status: "live" });
      expect((await pool().query(`select state, consumed_seq::int as consumed_seq from session_inputs where id = $1`, [input.id])).rows[0]).toEqual({ state: "consumed", consumed_seq: 1 });
      expect(await pending(f)).toBe(0);
      expect(settled).toEqual([{ requestId: input.id, outcome: "completed" }]);
    }));

  it("closes a question: its resolution lowers the approval count", () =>
    withFixtureStorage(async (_storage, f) => {
      await outbox(f.sessionId, "ask:1", { kind: "permission_request", toolCallId: "call-1", requestKind: "approval", name: "x", input: {} });
      await projectOutbox(deps(), { id: f.sessionId, workspaceId: f.workspaceId });
      expect((await session(f)).approvals).toBe(1);
      await outbox(f.sessionId, "res:1", { kind: "permission_resolved", toolCallId: "call-1", decision: "allow" });
      await projectOutbox(deps(), { id: f.sessionId, workspaceId: f.workspaceId });
      expect((await session(f)).approvals).toBe(0);
      expect((await events(f)).map((r) => r.source_id)).toEqual(["perm:call-1", "permres:call-1"]);
    }));

  it("adds an event once even when its row is projected again after a crash, and leaves no row pending", () =>
    withFixtureStorage(async (_storage, f) => {
      await pool().query(`insert into session_events (session_id, workspace_id, seq, source_id, kind, payload) values ($1, $2, 1, 'reply:1', 'assistant_text', '{"text":"Hello."}')`, [f.sessionId, f.workspaceId]);
      await pool().query(`update sessions set last_seq = 1 where id = $1`, [f.sessionId]);
      await outbox(f.sessionId, "reply:1", { kind: "assistant_text", text: "Hello.", model: null });
      await projectOutbox(deps(), { id: f.sessionId, workspaceId: f.workspaceId });
      expect(await events(f)).toHaveLength(1);
      expect(await pending(f)).toBe(0);
      expect(await projectOutbox(deps(), { id: f.sessionId, workspaceId: f.workspaceId })).toBe(0);
    }));

  it("refuses a session that a host runs", () =>
    withFixtureStorage(async (_storage, f) => {
      await pool().query(`update sessions set execution_target = 'host' where id = $1`, [f.sessionId]);
      await expect(pool().query(`select append_backend_session_events($1, $2, '[]'::jsonb, '{}'::text[])`, [f.sessionId, f.workspaceId])).rejects.toThrow("foreign_host");
    }));
});
