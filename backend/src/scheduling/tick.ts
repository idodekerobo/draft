import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchScheduledTask } from "./dispatch";
import { computeNextDueAt } from "./next-due-at";
import type { SandboxDeploymentConfig } from "../metaharness/sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import { recordError } from "../errors/record-error";
import { sweepStaleSynthesisRuns } from "../synthesis/reconcile-stale-runs";
import { retryFailedSynthesisRuns } from "../synthesis/retry-failed-runs";
import { advanceStuckWorkflows, failStrandedParents, sweepStaleStepRuns } from "../routine-steps/sweep";
import "../routine-steps/register-workflows";
import { failStaleRoutineSessions } from "../routines/fail-stale-routine-sessions";
import { drainEventInbox } from "../events/drain";
import { expireIdleCloudSessions } from "../cloud-sessions/expire";
import { reconcileCloudSessions } from "../cloud-sessions/reconcile";
import { wakeCloudSession } from "../cloud-sessions/wake";
import { runTokenSecret } from "../metaharness/runs/run-token-secret";
import { providerFor } from "../metaharness/sandbox/providers";

export interface RunSchedulingTickOptions {
  client: SupabaseClient;
  config: SandboxDeploymentConfig;
  now?: Date;
  dispatch?: typeof dispatchScheduledTask; // injectable for tests
  drain?: typeof drainEventInbox; // injectable for tests
  expire?: typeof expireIdleCloudSessions; // injectable for tests
  reconcile?: typeof reconcileCloudSessions; // injectable for tests
}

const TIMER_CLAIM_LIMIT = 100;
// If a 5-minute lease expires after a crash, the system task runs again.
const TIMER_LEASE_SECONDS = 5 * 60;

// task is the row as the claim left it, so its next_due_at is the lease, not the occurrence.
interface ClaimedTimer {
  task: ScheduledTaskRow;
  occurrence_at: string;
}

export async function runSchedulingTick(options: RunSchedulingTickOptions): Promise<void> {
  const now = options.now ?? new Date();
  const dispatch = options.dispatch ?? dispatchScheduledTask;
  const drain = options.drain ?? drainEventInbox;
  const expire = options.expire ?? expireIdleCloudSessions;
  const reconcile = options.reconcile ?? reconcileCloudSessions;

  const { data, error } = await options.client.rpc("claim_due_scheduled_tasks", {
    p_now: now.toISOString(),
    p_limit: TIMER_CLAIM_LIMIT,
    p_lease_seconds: TIMER_LEASE_SECONDS,
  });
  if (error) throw error;
  const claimed = (data ?? []) as ClaimedTimer[];

  for (const { task, occurrence_at: occurrenceAt } of claimed) {
    // The claim fired a one-off and cleared its next_due_at, so there is nothing to advance.
    if (task.schedule_kind === "once") continue;

    // The claim already enqueued an agent routine's event, so only its next occurrence is left.
    let dispatchedTask = task;
    if (task.task_type !== "agent_routine") {
      try {
        const fresh = await dispatch({ task, occurrenceAt, config: options.config, client: options.client });
        // Recompute from dispatch's fresh row, not the claimed copy.
        if (fresh) dispatchedTask = fresh;
      } catch (dispatchError) {
        await recordError({
          client: options.client,
          workspaceId: task.workspace_id,
          scheduledTaskId: task.id,
          operation: "scheduling",
          message: `Scheduled task ${task.id} (${task.task_type}) failed to dispatch`,
          code: "scheduled_task_dispatch_failed",
          detail: { task_type: task.task_type },
          error: dispatchError,
        });
        // Not rethrown -- one task's failure shouldn't stop the rest of the batch.
      }
    }

    try {
      // Guarded on the lease the claim wrote, so a schedule edit made meanwhile wins.
      // Advances on failure too, so a failing task retries at its next occurrence.
      const nextDueAt = computeNextDueAt({ ...dispatchedTask, next_due_at: occurrenceAt }, now);
      await advanceNextDueAt(options.client, task, nextDueAt);
    } catch (advanceError) {
      // Per-row catch: a throw here would strand the rest of the claimed batch until its lease expires.
      await recordError({
        client: options.client,
        workspaceId: task.workspace_id,
        scheduledTaskId: task.id,
        operation: "scheduling",
        message: `Scheduled task ${task.id} (${task.task_type}) failed to advance its next occurrence`,
        code: "scheduled_task_advance_failed",
        detail: { task_type: task.task_type },
        error: advanceError,
      });
    }
  }

  await drain().catch((drainError) => recordTickStepError(options.client, "Event inbox drain failed", drainError));

  // Each step is isolated so one failing never stops the tick.
  try {
    await sweepStaleSynthesisRuns(options.client);
  } catch (sweepError) {
    await recordTickStepError(options.client, "Stale synthesis run sweep failed", sweepError);
  }
  try {
    // Step runs: end the stale ones, give every routine run with steps one pass of the engine (it starts queued runs a
    // busy login held back, and finishes a run whose last callback never moved it on), then fail the ones with nothing left to wait for.
    if (options.config) {
      const { client, config } = options;
      await sweepStaleStepRuns(client, config, { now: new Date(now) });
      await advanceStuckWorkflows(client, config);
      await failStrandedParents(client, config, { now: new Date(now) });
    }
  } catch (sweepError) {
    await recordTickStepError(options.client, "Step run sweep failed", sweepError);
  }
  try {
    const { error } = await options.client.rpc("sweep_stale_sessions");
    if (error) throw error;
  } catch (sweepError) {
    await recordTickStepError(options.client, "Stale live session sweep failed", sweepError);
  }
  try {
    await failStaleRoutineSessions(options.client, now);
  } catch (sweepError) {
    await recordTickStepError(options.client, "Stale routine session sweep failed", sweepError);
  }
  try {
    await retryFailedSynthesisRuns({ client: options.client, config: options.config, now });
  } catch (retryError) {
    await recordTickStepError(options.client, "Failed synthesis run retry failed", retryError);
  }
  try {
    // Bootstrap refuses to start without sandbox settings, so only a caller that passes none reaches this skip.
    if (options.config?.provider) {
      await expire({ client: options.client, provider: providerFor(options.config.provider), now: () => now });
    }
  } catch (expireError) {
    await recordTickStepError(options.client, "Idle cloud session expiry failed", expireError);
  }
  try {
    if (options.config?.provider) {
      const { client, config } = options;
      const provider = providerFor(config.provider);
      await reconcile({
        client,
        provider,
        providerName: config.provider.kind,
        now: () => now,
        wake: (session) => wakeCloudSession(session, { client, provider, config, tokenSecret: runTokenSecret() }),
      });
    }
  } catch (reconcileError) {
    await recordTickStepError(options.client, "Cloud session reconcile failed", reconcileError);
  }
}

async function advanceNextDueAt(client: SupabaseClient, task: ScheduledTaskRow, nextDueAt: Date | null): Promise<void> {
  const { error } = await client
    .from("scheduled_tasks")
    .update({ next_due_at: nextDueAt ? nextDueAt.toISOString() : null, claimed_occurrence_at: null })
    .eq("id", task.id)
    .eq("workspace_id", task.workspace_id)
    .eq("next_due_at", task.next_due_at);
  if (error) throw error;
}

async function recordTickStepError(
  client: SupabaseClient,
  message: string,
  error: unknown,
): Promise<void> {
  // No workspace to attribute to, so recordError falls back to stderr.
  await recordError({
    client,
    workspaceId: null,
    operation: "scheduling",
    message,
    code: "scheduling_tick_failed",
    error,
  });
}
