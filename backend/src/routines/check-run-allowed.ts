import type { HarnessId } from "draft-core/harnesses";
import { routineAgentProblem } from "./agent-status";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceRow } from "../types/tables";

// max_cost_usd_per_day exists as a column but isn't read here yet.
export type CheckRunAllowedResult = { ok: true } | { ok: false; reason: string };

/** The built-in routines that check before they launch. Each counts its own runs against the daily cap. */
export type AdmittedRunKind = "synthesis" | "summarization";

/** Whether a built-in routine may start a run for this workspace now. Run it before any session or source is claimed. */
export async function checkRunAllowed(
  workspaceId: string,
  client: SupabaseClient,
  harness: HarnessId = "claude",
  kind: AdmittedRunKind = "synthesis",
): Promise<CheckRunAllowedResult> {
  const { data: workspaceData, error: workspaceError } = await client
    .from("workspaces")
    .select("runs_enabled, max_runs_per_day, inference_credential_id")
    .eq("id", workspaceId)
    .single();
  if (workspaceError) throw workspaceError;
  const workspace = workspaceData as Pick<
    WorkspaceRow,
    "runs_enabled" | "max_runs_per_day" | "inference_credential_id"
  >;

  if (!workspace.runs_enabled) {
    return { ok: false, reason: "runs_enabled is false for this workspace" };
  }

  // Fail fast here rather than deep inside resolveInferenceCredential,
  // after prepareRun has already created the run row.
  if (harness === "claude" && !workspace.inference_credential_id) {
    return { ok: false, reason: "no inference credential configured for this workspace" };
  }

  if (harness !== "claude") {
    const problem = await routineAgentProblem(client, workspaceId, harness);
    if (problem) return { ok: false, reason: problem.message };
  }

  if (workspace.max_runs_per_day !== null) {
    // UTC day boundary; counts every status, not just successes.
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const { count, error: countError } = await client
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("kind", kind)
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
