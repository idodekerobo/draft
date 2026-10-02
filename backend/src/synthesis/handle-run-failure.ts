import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import type { ErrorOperation, SynthesisRunStatus } from "../types/enums";
import type { SynthesisRunRow } from "../types/tables";

// A run stuck in any of these forever (crashed sandbox, dead tunnel) blocks
// every future run for its workspace until failed.
export const ACTIVE_WRITER_STATUSES: SynthesisRunStatus[] = [
  "preparing",
  "running",
  "validating",
  "committing",
];

// Wait after attempt N fails before retry N+1. Attempt 4 failing ends the
// fast retries; the normal cron carries on after that.
const FAST_RETRY_BACKOFF_MINUTES = [5, 10, 15];
export const MAX_FAST_RETRIES = FAST_RETRY_BACKOFF_MINUTES.length;

export interface RetryPlan {
  nextRetryAt: Date | null;
  exhausted: boolean;
}

export function retryPlan(attempt: number, completedAt: Date): RetryPlan {
  const waitMinutes = FAST_RETRY_BACKOFF_MINUTES[attempt - 1];
  if (waitMinutes === undefined) return { nextRetryAt: null, exhausted: true };
  return {
    nextRetryAt: new Date(completedAt.getTime() + waitMinutes * 60_000),
    exhausted: false,
  };
}

export interface FailSynthesisRunInput {
  client: SupabaseClient;
  runId: string;
  failureCode: string;
  operation: ErrorOperation;
  // Stored on the run row and used as the error row message.
  reason: string;
  error?: unknown;
  detail?: Record<string, unknown>;
}

type FailedRunRow = Pick<
  SynthesisRunRow,
  "workspace_id" | "scheduled_task_id" | "attempt" | "retry_of_run_id" | "sandbox_machine_id"
>;

// Marks the run failed and writes exactly one error row carrying the attempt
// tracking. Returns false (and writes nothing) when the run already left an
// active status, so a late callback cannot clobber a finished run.
export async function failSynthesisRun(input: FailSynthesisRunInput): Promise<boolean> {
  const { client, runId } = input;
  const completedAt = new Date();

  const { data, error } = await client
    .from("synthesis_runs")
    .update({
      status: "failed",
      outcome: "failure",
      result_summary: input.reason,
      completed_at: completedAt.toISOString(),
    })
    .eq("id", runId)
    .in("status", ACTIVE_WRITER_STATUSES)
    .select("workspace_id, scheduled_task_id, attempt, retry_of_run_id, sandbox_machine_id");
  if (error) throw error;
  const run = ((data ?? []) as FailedRunRow[])[0];
  if (!run) return false;

  const plan = retryPlan(run.attempt, completedAt);
  await recordError({
    client,
    workspaceId: run.workspace_id,
    scheduledTaskId: run.scheduled_task_id,
    synthesisRunId: runId,
    operation: input.operation,
    message: input.reason,
    code: input.failureCode,
    error: input.error,
    detail: {
      ...input.detail,
      failure_code: input.failureCode,
      attempt: run.attempt,
      consecutive_failures: run.attempt,
      retry_of_run_id: run.retry_of_run_id,
      max_fast_retries: MAX_FAST_RETRIES,
      next_retry_at: plan.nextRetryAt?.toISOString() ?? null,
      fast_retries_exhausted: plan.exhausted,
      sandbox_machine_id: run.sandbox_machine_id,
    },
  });

  if (run.attempt === MAX_FAST_RETRIES + 1) {
    await recordError({
      client,
      workspaceId: run.workspace_id,
      scheduledTaskId: run.scheduled_task_id,
      synthesisRunId: runId,
      operation: "execution",
      message: `Synthesis failed ${run.attempt} times in a row; fast retries are used up`,
      code: "synthesis_retries_exhausted",
      detail: { attempt: run.attempt, max_fast_retries: MAX_FAST_RETRIES },
    });
  }
  return true;
}
