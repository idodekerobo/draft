import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlySandboxRunReceipt } from "../sandbox";
import type { LaunchSynthesisRunOptions } from "./types";
import type { SourceItemRow, WorkspaceRow } from "../types/tables";

// Bumped whenever the rendered prompt/schema contract (task #4) changes in a
// way that should be distinguishable in synthesis_runs.prompt_version history.
const PROMPT_VERSION = "synthesis-v1";

export async function prepareRun(
  options: Pick<
    LaunchSynthesisRunOptions,
    "workspaceId" | "triggerType" | "sourceItemIds" | "scheduledTaskId" | "client"
  >,
): Promise<string> {
  const client =
    options.client ?? (await import("../db/client")).serviceClient;

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

  // Scheduled runs are keyed on {scheduled_task_id}:{occurrence_timestamp_utc}
  // so re-enqueueing the same occurrence is a no-op; all other trigger types
  // get a fresh uuid per call.
  const idempotencyKey = options.scheduledTaskId
    ? `${options.scheduledTaskId}:${new Date().toISOString()}`
    : `${options.triggerType}:${randomUUID()}`;

  const { data: runData, error: runError } = await client
    .from("synthesis_runs")
    .insert({
      workspace_id: options.workspaceId,
      scheduled_task_id: options.scheduledTaskId ?? null,
      idempotency_key: idempotencyKey,
      status: "queued",
      trigger_type: options.triggerType,
      base_context_version_id: workspace.current_context_version_id,
      attempt: 1,
      prompt_version: PROMPT_VERSION,
    })
    .select("id")
    .single();
  if (runError) throw runError;
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
