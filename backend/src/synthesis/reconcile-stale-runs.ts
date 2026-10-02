import type { SupabaseClient } from "@supabase/supabase-js";
import type { SynthesisRunStatus } from "../types/enums";
import { ACTIVE_WRITER_STATUSES, failSynthesisRun } from "./handle-run-failure";

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

// Fails any active-writer row older than the cutoff and logs one `errors` row
// per swept run, freeing the workspace. Retrying is the scheduler tick's job.
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

  const swept: SweptRun[] = [];
  for (const run of candidates) {
    const failed = await failSynthesisRun({
      client,
      runId: run.id,
      failureCode: "synthesis_run_stale",
      operation: "execution",
      reason:
        `Run was still ${run.status} past the staleness cutoff with no ` +
        "callback from the sandbox.",
      detail: { swept_from_status: run.status, cutoff: cutoffIso },
    });
    if (failed) swept.push(run);
  }

  return swept;
}
