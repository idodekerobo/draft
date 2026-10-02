import type { SupabaseClient } from "@supabase/supabase-js";
import type { SandboxDeploymentConfig } from "../sandbox";
import { checkRunAllowed, RunNotAllowedError } from "./check-run-allowed";
import { getPendingSynthesisSourceItemIds } from "./get-pending-source-items";
import { MAX_FAST_RETRIES, retryPlan } from "./handle-run-failure";
import { getLatestSynthesisRun } from "./latest-run";
import { launchSynthesisRun } from "./orchestrate-run";
import { OccurrenceAlreadyDispatchedError, WorkspaceRunAlreadyActiveError } from "./prepare-run";
import type { SynthesisRunRow } from "../types/tables";

// Older failures are left to the normal cron.
const RETRY_WINDOW_MS = 2 * 60 * 60_000;

export interface RetryFailedRunsOptions {
  client: SupabaseClient;
  config: SandboxDeploymentConfig;
  now?: Date;
  // Injectable for tests.
  launch?: typeof launchSynthesisRun;
  getPendingSourceItemIds?: typeof getPendingSynthesisSourceItemIds;
}

type FailedRun = Pick<
  SynthesisRunRow,
  "id" | "workspace_id" | "scheduled_task_id" | "attempt" | "completed_at"
>;

// Starts the next fast retry for every failed run whose backoff has elapsed.
// Returns the ids of the runs it retried.
export async function retryFailedSynthesisRuns(
  options: RetryFailedRunsOptions,
): Promise<string[]> {
  const { client } = options;
  const now = options.now ?? new Date();
  const launch = options.launch ?? launchSynthesisRun;
  const getPending = options.getPendingSourceItemIds ?? getPendingSynthesisSourceItemIds;

  const { data, error } = await client
    .from("synthesis_runs")
    .select("id, workspace_id, scheduled_task_id, attempt, completed_at")
    .eq("status", "failed")
    .lte("attempt", MAX_FAST_RETRIES)
    .gte("completed_at", new Date(now.getTime() - RETRY_WINDOW_MS).toISOString());
  if (error) throw error;

  const retried: string[] = [];
  for (const run of (data ?? []) as FailedRun[]) {
    if (!run.completed_at) continue;
    const { nextRetryAt } = retryPlan(run.attempt, new Date(run.completed_at));
    if (!nextRetryAt || nextRetryAt > now) continue;

    // A newer run (manual, cron or an earlier retry) supersedes this one.
    const latest = await getLatestSynthesisRun(client, run.workspace_id);
    if (latest?.id !== run.id) continue;

    // Checked here so a paused workspace does not log a denial every tick.
    const admission = await checkRunAllowed(run.workspace_id, client);
    if (!admission.ok) continue;

    // Failed runs consume no items, so the pending set is re-read each time.
    const sourceItemIds = await getPending(run.workspace_id, client);
    if (sourceItemIds.length === 0) continue;

    try {
      await launch({
        workspaceId: run.workspace_id,
        triggerType: "retry",
        retryOfRunId: run.id,
        sourceItemIds,
        scheduledTaskId: run.scheduled_task_id ?? undefined,
        config: options.config,
        client,
        now,
      });
      retried.push(run.id);
    } catch (launchError) {
      if (
        launchError instanceof RunNotAllowedError ||
        launchError instanceof WorkspaceRunAlreadyActiveError ||
        launchError instanceof OccurrenceAlreadyDispatchedError
      ) {
        continue;
      }
      // launchSynthesisRun already recorded the failure and failed the new run.
    }
  }
  return retried;
}
