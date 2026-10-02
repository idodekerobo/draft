import type { SupabaseClient } from "@supabase/supabase-js";
import type { SynthesisRunRow } from "../types/tables";

export type LatestSynthesisRun = Pick<
  SynthesisRunRow,
  "id" | "status" | "attempt" | "completed_at" | "scheduled_task_id"
>;

export async function getLatestSynthesisRun(
  client: SupabaseClient,
  workspaceId: string,
): Promise<LatestSynthesisRun | null> {
  const { data, error } = await client
    .from("synthesis_runs")
    .select("id, status, attempt, completed_at, scheduled_task_id")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as LatestSynthesisRun[])[0] ?? null;
}
