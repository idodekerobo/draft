import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchScheduledTask } from "./dispatch";
import { computeNextDueAt } from "./next-due-at";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import { recordError } from "../errors/record-error";

export interface RunSchedulingTickOptions {
  client: SupabaseClient;
  config: SandboxDeploymentConfig;
  now?: Date;
  dispatch?: typeof dispatchScheduledTask; // injectable for tests
}

// No advisory lock: single instance at pilot scale. Needs a transactional
// row-claim (not a session lock -- no pinned connection) before a second
// instance ever runs this.
export async function runSchedulingTick(options: RunSchedulingTickOptions): Promise<void> {
  const now = options.now ?? new Date();
  const dispatch = options.dispatch ?? dispatchScheduledTask;

  const { data, error } = await options.client
    .from("scheduled_tasks")
    .select("*")
    .eq("enabled", true)
    .lte("next_due_at", now.toISOString());
  if (error) throw error;
  const dueTasks = (data ?? []) as ScheduledTaskRow[];

  for (const task of dueTasks) {
    // Not now() -- keeps the idempotency key stable across duplicate dispatches.
    const occurrenceAt = task.next_due_at ?? now.toISOString();

    try {
      await dispatch({
        task,
        occurrenceAt,
        config: options.config,
        client: options.client,
      });
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

    // Always advance, success or failure, so a failing task retries next
    // occurrence instead of spinning every tick.
    const nextDueAt = computeNextDueAt(task, now);
    const { error: advanceError } = await options.client
      .from("scheduled_tasks")
      .update({
        next_due_at: nextDueAt.toISOString(),
        last_enqueued_at: now.toISOString(),
      })
      .eq("id", task.id)
      .eq("workspace_id", task.workspace_id);
    if (advanceError) throw advanceError;
  }
}
