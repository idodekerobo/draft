import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HostStore, PendingInput } from "./ports";

const INPUT_KINDS = ["message", "permission_decision", "stop", "set_mode", "end"];

/** The host's database: the claim and run functions through the service client, and the recovery query straight on Postgres. */
export function createHostStore(deps: { pool: Pool; client: SupabaseClient }): HostStore {
  const { pool, client } = deps;
  const interval = (seconds: number) => `${seconds} seconds`;
  return {
    async claim(sessionId, owner, ttlSeconds) {
      const { data, error } = await client.rpc("claim_embedded_agent", { p_session_id: sessionId, p_owner: owner, p_ttl: interval(ttlSeconds) });
      if (error) throw error;
      const result = data as { claimed: boolean; epoch: number };
      return { claimed: result.claimed === true, epoch: Number(result.epoch) };
    },
    async renew(sessionId, owner, epoch, ttlSeconds) {
      const { data, error } = await client.rpc("renew_embedded_agent", { p_session_id: sessionId, p_owner: owner, p_epoch: epoch, p_ttl: interval(ttlSeconds) });
      if (error) throw error;
      return data === true;
    },
    async release(sessionId, owner, epoch) {
      const { error } = await client.rpc("release_embedded_agent", { p_session_id: sessionId, p_owner: owner, p_epoch: epoch });
      if (error) throw error;
    },
    async stillOwner(sessionId, owner, epoch) {
      const { rows } = await pool.query(
        `select payload->>'owner' as owner, (payload->>'epoch')::bigint::float8 as epoch, ((payload->>'expires_at')::timestamptz > now()) as live
           from embedded_agent_state where session_id = $1 and kind = 'claim' and key = 'owner'`,
        [sessionId],
      );
      const claim = rows[0];
      return !!claim && claim.owner === owner && Number(claim.epoch) === epoch && claim.live === true;
    },
    async loadSession(sessionId) {
      const { data, error } = await client
        .from("sessions")
        .select("id, workspace_id, owner_user_id, model, status, ended_at, deleted_at")
        .eq("id", sessionId)
        .eq("execution_target", "backend")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as { id: string; workspace_id: string; owner_user_id: string; model: string | null; ended_at: string | null; deleted_at: string | null; status: string };
      return { id: row.id, workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, model: row.model, ended: row.status === "ended" || row.ended_at !== null || row.deleted_at !== null };
    },
    async pendingInputs(sessionId) {
      const { data, error } = await client
        .from("session_inputs")
        .select("id, kind, state, author_user_id, author_name, payload")
        .eq("session_id", sessionId)
        .in("state", ["queued", "delivering", "uncertain"])
        .in("kind", INPUT_KINDS)
        .is("dismissed_at", null)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<{ id: string; kind: PendingInput["kind"]; state: PendingInput["state"]; author_user_id: string; author_name: string; payload: Record<string, unknown> }>).map((row) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        authorUserId: row.author_user_id,
        authorName: row.author_name,
        payload: row.payload ?? {},
      }));
    },
    async transition(inputId, sessionId, from, to, reason) {
      const { data, error } = await client.rpc("transition_session_input", { p_input_id: inputId, p_session_id: sessionId, p_from: from, p_to: to, p_reason: reason, p_consumed_seq: null });
      if (error) throw error;
      return data === true;
    },
    async setSessionModel(sessionId, model) {
      const { error } = await client.from("sessions").update({ model }).eq("id", sessionId);
      if (error) throw error;
    },
    async sessionsNeedingRecovery() {
      const { rows } = await pool.query(
        `select s.id from sessions s
          where s.execution_target = 'backend' and s.status <> 'ended' and s.ended_at is null and s.deleted_at is null
            and (
              exists (select 1 from session_inputs i where i.session_id = s.id and i.kind = any($1::text[])
                       and i.state in ('queued', 'delivering', 'uncertain') and i.dismissed_at is null)
              or exists (select 1 from embedded_agent_state o where o.session_id = s.id and o.kind = 'outbox' and o.projected_at is null)
              or exists (select 1 from agent_runs r where r.session_id = s.id and r.status in ('queued', 'preparing', 'running', 'validating', 'committing'))
            )
          limit 200`,
        [INPUT_KINDS],
      );
      return rows.map((row) => row.id as string);
    },
  };
}
