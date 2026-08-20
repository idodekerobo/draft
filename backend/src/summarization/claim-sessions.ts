import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentSessionRow } from "../types/tables";

const DEFAULT_LEASE_SECONDS = 25 * 60;

export async function claimPendingSummarySessions(
  workspaceId: string,
  limit: number,
  client: SupabaseClient,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<AgentSessionRow[]> {
  const { data, error } = await client.rpc("claim_pending_summary_sessions", {
    p_workspace_id: workspaceId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return (data ?? []) as AgentSessionRow[];
}
