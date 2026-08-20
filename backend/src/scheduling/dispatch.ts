import type { SupabaseClient } from "@supabase/supabase-js";
import { RunNotAllowedError } from "../synthesis/check-run-allowed";
import { reconcileFirefliesConnection } from "../ingestion/fireflies/reconcile";
import { materializeSlackBatches } from "../ingestion/slack/materialize-batches";
import { getReadySourceItemIds } from "../synthesis/get-ready-source-items";
import { launchSynthesisRun } from "../synthesis/orchestrate-run";
import { launchSummarizationBatch } from "../summarization/run-summarization-batch";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";

// Injectable, defaulting to the real implementations, so tests can
// substitute fakes without mock.module's cross-file leakage.
export interface DispatchDependencies {
  reconcileFirefliesConnection: typeof reconcileFirefliesConnection;
  materializeSlackBatches: typeof materializeSlackBatches;
  launchSynthesisRun: typeof launchSynthesisRun;
  getReadySourceItemIds: typeof getReadySourceItemIds;
  launchSummarizationBatch: typeof launchSummarizationBatch;
}

const defaultDependencies: DispatchDependencies = {
  reconcileFirefliesConnection,
  materializeSlackBatches,
  launchSynthesisRun,
  getReadySourceItemIds,
  launchSummarizationBatch,
};

// No retry -- both handlers already re-run every interval_seconds, and both
// are cursor-based and idempotent, so a failed pass just gets picked up next
// tick with nothing lost.
async function dispatchIngestSource(
  task: ScheduledTaskRow,
  client: SupabaseClient,
  deps: DispatchDependencies,
): Promise<void> {
  if (!task.source_connection_id) {
    throw new Error(`ingest_source task ${task.id} has no source_connection_id`);
  }

  const { data: connectionData, error: connectionError } = await client
    .from("source_connections")
    .select("id, workspace_id, provider, status, cursor_json")
    .eq("id", task.source_connection_id)
    .eq("workspace_id", task.workspace_id)
    .single();
  if (connectionError) throw connectionError;
  const connection = connectionData as {
    id: string;
    workspace_id: string;
    provider: string;
    status: string;
    cursor_json: Record<string, unknown>;
  };

  // Disconnect can disable a schedule after this task was claimed; the write
  // RPCs remain the final backstop after this early stale-work check.
  if (connection.status !== "active" && connection.status !== "degraded") return;

  if (connection.provider === "fireflies") {
    await deps.reconcileFirefliesConnection(connection, client);
  } else if (connection.provider === "slack") {
    await deps.materializeSlackBatches(connection, client);
  } else {
    throw new Error(
      `ingest_source task ${task.id} references unsupported provider "${connection.provider}"`,
    );
  }
}

// No retry here either -- a crash is handled by the next scheduled
// occurrence plus the stale-run sweep, not by hammering WorkspaceRunAlreadyActiveError.
async function dispatchSynthesizeWorkspace(
  task: ScheduledTaskRow,
  occurrenceAt: string,
  config: SandboxDeploymentConfig,
  client: SupabaseClient,
  deps: DispatchDependencies,
): Promise<void> {
  const sourceItemIds = await deps.getReadySourceItemIds(task.workspace_id, client);
  if (sourceItemIds.length === 0) return; // avoids spending quota on an empty run

  try {
    await deps.launchSynthesisRun({
      workspaceId: task.workspace_id,
      triggerType: "schedule",
      sourceItemIds,
      scheduledTaskId: task.id,
      occurrenceAt,
      config,
      client,
    });
  } catch (error) {
    // launchSynthesisRun already logs a denial to `errors` -- don't double-log.
    if (error instanceof RunNotAllowedError) return;
    throw error;
  }
}

// No retry here either -- summarization sessions are individually leased
// (agent_sessions.summary_status/summary_lease_until), so a crash just
// leaves them for the next tick's claim to pick back up.
async function dispatchSummarizeSessions(
  task: ScheduledTaskRow,
  config: SandboxDeploymentConfig,
  client: SupabaseClient,
  deps: DispatchDependencies,
): Promise<void> {
  await deps.launchSummarizationBatch({
    workspaceId: task.workspace_id,
    config,
    client,
  });
}

export interface DispatchScheduledTaskOptions {
  task: ScheduledTaskRow;
  occurrenceAt: string;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
}

// Refetches the task fresh rather than trusting the tick's initial select,
// and returns that row so the tick can recompute next_due_at from it too.
export async function dispatchScheduledTask(
  options: DispatchScheduledTaskOptions,
  deps: DispatchDependencies = defaultDependencies,
): Promise<ScheduledTaskRow | null> {
  const { data: freshData, error: freshError } = await options.client
    .from("scheduled_tasks")
    .select("*")
    .eq("id", options.task.id)
    .eq("workspace_id", options.task.workspace_id)
    .maybeSingle();
  if (freshError) throw freshError;
  const fresh = freshData as ScheduledTaskRow | null;
  if (!fresh || !fresh.enabled) return fresh;

  if (fresh.task_type === "ingest_source") {
    await dispatchIngestSource(fresh, options.client, deps);
    return fresh;
  }
  if (fresh.task_type === "synthesize_workspace") {
    await dispatchSynthesizeWorkspace(fresh, options.occurrenceAt, options.config, options.client, deps);
    return fresh;
  }
  if (fresh.task_type === "summarize_sessions") {
    await dispatchSummarizeSessions(fresh, options.config, options.client, deps);
    return fresh;
  }
  // rebuild_projection: no projection exists yet -- fail loud, don't silently succeed.
  throw new Error(`Unsupported scheduled task_type "${fresh.task_type}" for task ${fresh.id}`);
}
