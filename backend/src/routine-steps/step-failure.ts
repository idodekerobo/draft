import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { releaseCodexLeaseForRun } from "../credentials/codex-credential";
import { recordError } from "../errors/record-error";
import type { AgentRunRow } from "../types/tables";
import { MAX_RATE_LIMITED_STEP_ATTEMPTS, MAX_STEP_ATTEMPTS, RATE_LIMIT_BACKOFF_MINUTES } from "./types";

/** The category a runner reports when the provider limited its rate. Saved in `failure_detail`. */
export const RATE_LIMITED = "rate_limit";

export const isRateLimited = (run: Pick<AgentRunRow, "failure_detail">): boolean => run.failure_detail === RATE_LIMITED;

/** True while a failed step run may still be retried. */
export const hasAttemptsLeft = (run: Pick<AgentRunRow, "attempt" | "failure_detail">): boolean =>
  run.attempt < (isRateLimited(run) ? MAX_RATE_LIMITED_STEP_ATTEMPTS : MAX_STEP_ATTEMPTS);

/** The time before which the retry of a failed run must not start. A rate limit waits; any other failure does not. */
export function retryNotBefore(failed: Pick<AgentRunRow, "attempt" | "failure_detail" | "completed_at">): Date {
  const completed = failed.completed_at ? new Date(failed.completed_at) : new Date(0);
  const minutes = isRateLimited(failed) ? (RATE_LIMIT_BACKOFF_MINUTES[failed.attempt - 1] ?? RATE_LIMIT_BACKOFF_MINUTES.at(-1)!) : 0;
  return new Date(completed.getTime() + minutes * 60_000);
}

export interface FailStepRunInput {
  client: SupabaseClient;
  runId: string;
  failureCode: string;
  reason: string;
  /** The runner's failure category, such as `rate_limit`. Saved so the retry can wait. */
  category?: string | null;
  error?: unknown;
  detail?: Record<string, unknown>;
}

/**
 * Ends a step run that has not ended: queued or active. Returns false and writes nothing when it had already ended,
 * so a late callback cannot change a finished run.
 */
export async function failStepRun(input: FailStepRunInput): Promise<AgentRunRow | null> {
  const { client, runId } = input;
  const { data, error } = await client
    .from("agent_runs")
    .update({
      status: "failed",
      failure_code: input.failureCode,
      failure_detail: input.category ?? null,
      summary: input.reason,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("kind", "step")
    .in("status", ["queued", ...ACTIVE_AGENT_RUN_STATUSES])
    .select("*");
  if (error) throw error;
  const run = ((data ?? []) as AgentRunRow[])[0];
  if (!run) return null;
  if (run.harness === "codex") await releaseCodexLeaseForRun(client, run.workspace_id, runId);
  await recordError({
    client,
    workspaceId: run.workspace_id,
    scheduledTaskId: run.scheduled_task_id,
    agentRunId: runId,
    operation: "execution",
    message: input.reason,
    code: input.failureCode,
    error: input.error,
    detail: { ...input.detail, failure_code: input.failureCode, category: input.category ?? null, step_key: run.step_key, parent_run_id: run.parent_run_id, attempt: run.attempt },
  });
  return run;
}
