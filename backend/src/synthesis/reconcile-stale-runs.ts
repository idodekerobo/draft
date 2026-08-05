import type { SupabaseClient } from "@supabase/supabase-js";
import type { SynthesisRunStatus } from "../types/enums";

// A run stuck in any of these forever (crashed sandbox, dead tunnel) blocks
// every future run for its workspace until swept.
const ACTIVE_WRITER_STATUSES: SynthesisRunStatus[] = [
  "preparing",
  "running",
  "validating",
  "committing",
];

// 10-minute margin past the sandbox's own 20-minute wall-clock timeout.
export const STALE_RUN_TIMEOUT_MS = 30 * 60_000;

export interface StaleRunSweepOptions {
  workspaceId?: string;
  olderThanMs?: number;
}

export interface SweptRun {
  id: string;
  workspace_id: string;
  status: SynthesisRunStatus;
}

// Fails (does not relaunch) any active-writer row older than the cutoff and
// logs one `errors` row per swept run, freeing the workspace for its next run.
// TODO - relaunching a replacement run needs a scheduler; not done here.
export async function sweepStaleSynthesisRuns(
  client: SupabaseClient,
  options: StaleRunSweepOptions = {},
): Promise<SweptRun[]> {
  const cutoffIso = new Date(
    Date.now() - (options.olderThanMs ?? STALE_RUN_TIMEOUT_MS),
  ).toISOString();

  // A separate read, since UPDATE ... RETURNING would only give us the
  // post-update ("failed") status, not the original one.
  let selectQuery = client
    .from("synthesis_runs")
    .select("id, workspace_id, status")
    .in("status", ACTIVE_WRITER_STATUSES)
    .lt("created_at", cutoffIso);
  if (options.workspaceId) {
    selectQuery = selectQuery.eq("workspace_id", options.workspaceId);
  }
  const { data: candidateData, error: selectError } = await selectQuery;
  if (selectError) throw selectError;
  const candidates = (candidateData ?? []) as SweptRun[];
  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((run) => run.id);
  const { error: updateError } = await client
    .from("synthesis_runs")
    .update({
      status: "failed",
      outcome: "failure",
      result_summary:
        "Reconciliation swept this run: it was still active past the " +
        "staleness cutoff with no callback, most likely a crashed or " +
        "unresponsive sandbox.",
      completed_at: new Date().toISOString(),
    })
    .in("id", candidateIds)
    // Re-checked so a run that completed between the two queries above
    // isn't clobbered back to "failed".
    .in("status", ACTIVE_WRITER_STATUSES);
  if (updateError) throw updateError;

  for (const run of candidates) {
    const { error: errorInsertError } = await client.from("errors").insert({
      workspace_id: run.workspace_id,
      synthesis_run_id: run.id,
      operation: "execution",
      message: `Synthesis run ${run.id} swept as stale from status "${run.status}"`,
      detail_json: { swept_from_status: run.status, cutoff: cutoffIso },
    });
    if (errorInsertError) throw errorInsertError;
  }

  return candidates;
}
