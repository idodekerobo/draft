import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlySandboxRunReceipt } from "../sandbox";
import { sweepStaleSynthesisRuns } from "./reconcile-stale-runs";
import type { LaunchSynthesisRunOptions } from "./types";
import type { SourceItemRow, WorkspaceRow } from "../types/tables";

// Bumped whenever the rendered prompt/schema contract (task #4) changes in a
// way that should be distinguishable in synthesis_runs.prompt_version history.
const PROMPT_VERSION = "synthesis-v1";

// Postgres unique_violation, raised here by synthesis_runs_one_active_writer.
const UNIQUE_VIOLATION = "23505";

// Thrown when a workspace already has a run in preparing/running/validating/
// committing. Callers triggering ad hoc (non-scheduled) runs should surface
// this as "try again shortly" rather than a raw DB error.
export class WorkspaceRunAlreadyActiveError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} already has an active synthesis run`);
    this.name = "WorkspaceRunAlreadyActiveError";
  }
}

export async function prepareRun(
  options: Pick<
    LaunchSynthesisRunOptions,
    "workspaceId" | "triggerType" | "sourceItemIds" | "scheduledTaskId" | "occurrenceAt" | "client"
  >,
): Promise<string> {
  const client =
    options.client ?? (await import("../db/client")).serviceClient;

  await sweepStaleSynthesisRuns(client, { workspaceId: options.workspaceId });

  const { data: workspaceData, error: workspaceError } = await client
    .from("workspaces")
    .select("current_context_version_id")
    .eq("id", options.workspaceId)
    .single();
  if (workspaceError) throw workspaceError;
  const workspace = workspaceData as Pick<
    WorkspaceRow,
    "current_context_version_id"
  >;
  if (!workspace.current_context_version_id) {
    throw new Error(
      `Workspace ${options.workspaceId} has no current_context_version_id — cannot prepare a synthesis run without a base version`,
    );
  }

  // {scheduled_task_id}:{occurrence_at} so duplicate dispatches of the same
  // occurrence collide on one key; {trigger_type}:{uuid} otherwise.
  if (options.scheduledTaskId && !options.occurrenceAt) {
    throw new Error("prepareRun: scheduledTaskId requires occurrenceAt for a stable idempotency key");
  }
  const idempotencyKey = options.scheduledTaskId
    ? `${options.scheduledTaskId}:${options.occurrenceAt}`
    : `${options.triggerType}:${randomUUID()}`;

  // "preparing", not "queued": synthesis_runs_one_active_writer only guards
  // preparing/running/validating/committing, so the row is protected from
  // the moment it's created rather than only once markRunLaunched promotes it.
  const { data: runData, error: runError } = await client
    .from("synthesis_runs")
    .insert({
      workspace_id: options.workspaceId,
      scheduled_task_id: options.scheduledTaskId ?? null,
      idempotency_key: idempotencyKey,
      status: "preparing",
      trigger_type: options.triggerType,
      base_context_version_id: workspace.current_context_version_id,
      attempt: 1,
      prompt_version: PROMPT_VERSION,
    })
    .select("id")
    .single();
  if (runError) {
    // Checked by message, not just the 23505 code: a (workspace_id,
    // idempotency_key) collision is a different, unrelated situation.
    if (
      runError.code === UNIQUE_VIOLATION &&
      runError.message.includes("synthesis_runs_one_active_writer")
    ) {
      throw new WorkspaceRunAlreadyActiveError(options.workspaceId);
    }
    throw runError;
  }
  const runId = (runData as { id: string }).id;

  if (options.sourceItemIds.length > 0) {
    const { data: sourceItemsData, error: sourceItemsError } = await client
      .from("source_items")
      .select("id, external_version, content_hash")
      .in("id", options.sourceItemIds);
    if (sourceItemsError) throw sourceItemsError;
    const sourceItems = (sourceItemsData ?? []) as Pick<
      SourceItemRow,
      "id" | "external_version" | "content_hash"
    >[];
    const sourceItemsById = new Map(
      sourceItems.map((item) => [item.id, item]),
    );

    const membershipRows = options.sourceItemIds.map((sourceItemId, position) => {
      const sourceItem = sourceItemsById.get(sourceItemId);
      if (!sourceItem) {
        throw new Error(`Missing source item ${sourceItemId} while preparing run`);
      }
      return {
        workspace_id: options.workspaceId,
        synthesis_run_id: runId,
        source_item_id: sourceItemId,
        position,
        source_item_version: sourceItem.external_version,
        content_hash: sourceItem.content_hash,
      };
    });

    const { error: membershipError } = await client
      .from("synthesis_run_source_items")
      .insert(membershipRows);
    if (membershipError) throw membershipError;
  }

  return runId;
}

export async function markRunLaunched(
  runId: string,
  receipt: FlySandboxRunReceipt,
  client?: SupabaseClient,
): Promise<void> {
  void receipt;
  const resolvedClient =
    client ?? (await import("../db/client")).serviceClient;

  const { error } = await resolvedClient
    .from("synthesis_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw error;
}
