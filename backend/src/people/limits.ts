import type { SupabaseClient } from "@supabase/supabase-js";

/** How many times a run has used a tool so far. Only calls that worked count, so a refusal does not use up the budget. */
export async function countRunToolCalls(client: SupabaseClient, runId: string, toolName: string): Promise<number> {
  const { count, error } = await client
    .from("agent_run_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("agent_run_id", runId)
    .eq("tool_name", toolName)
    .eq("status", "ok");
  if (error) throw error;
  return count ?? 0;
}
