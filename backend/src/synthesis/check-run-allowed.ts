import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceRow } from "../types/tables";

// Thrown by launchSynthesisRun when checkRunAllowed denies. Callers should
// treat this as "paused," not a failure to retry.
export class RunNotAllowedError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly reason: string,
  ) {
    super(`Synthesis run denied for workspace ${workspaceId}: ${reason}`);
    this.name = "RunNotAllowedError";
  }
}

// max_cost_usd_per_day exists as a column but isn't read here yet.
export type CheckRunAllowedResult = { ok: true } | { ok: false; reason: string };

export async function checkRunAllowed(
  workspaceId: string,
  client: SupabaseClient,
): Promise<CheckRunAllowedResult> {
  const { data: workspaceData, error: workspaceError } = await client
    .from("workspaces")
    .select("runs_enabled, max_runs_per_day")
    .eq("id", workspaceId)
    .single();
  if (workspaceError) throw workspaceError;
  const workspace = workspaceData as Pick<WorkspaceRow, "runs_enabled" | "max_runs_per_day">;

  if (!workspace.runs_enabled) {
    return { ok: false, reason: "runs_enabled is false for this workspace" };
  }

  if (workspace.max_runs_per_day !== null) {
    // UTC day boundary; counts every status, not just successes.
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const { count, error: countError } = await client
      .from("synthesis_runs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", startOfUtcDay.toISOString());
    if (countError) throw countError;

    if ((count ?? 0) >= workspace.max_runs_per_day) {
      return {
        ok: false,
        reason: `max_runs_per_day (${workspace.max_runs_per_day}) already reached for today`,
      };
    }
  }

  return { ok: true };
}
