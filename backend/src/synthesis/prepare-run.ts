import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlySandboxRunReceipt } from "../sandbox";
import { canonicalDocumentsHash } from "./context-version-files";
import { computeMemoryAdditions, ensureMemoryProvisioned } from "./provision-memory";
import { sweepStaleSynthesisRuns } from "./reconcile-stale-runs";
import { recordError } from "../errors/record-error";
import { getLatestSynthesisRun } from "./latest-run";
import type { LaunchSynthesisRunOptions } from "./types";
import type {
  SourceItemRow,
  WorkspaceContextVersionRow,
  WorkspaceRow,
} from "../types/tables";

// Bumped whenever the rendered prompt/schema contract (task #4) changes in a
// way that should be distinguishable in synthesis_runs.prompt_version history.
const PROMPT_VERSION = "synthesis-v1";

// Postgres unique_violation, raised here by synthesis_runs_one_active_writer
// or synthesis_runs_workspace_id_idempotency_key_key.
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

// Thrown on an idempotency-key collision -- this occurrence was already
// dispatched by another caller. Safe to treat as a no-op.
export class OccurrenceAlreadyDispatchedError extends Error {
  constructor(public readonly workspaceId: string, public readonly idempotencyKey: string) {
    super(`Occurrence ${idempotencyKey} for workspace ${workspaceId} was already dispatched`);
    this.name = "OccurrenceAlreadyDispatchedError";
  }
}

export async function prepareRun(
  options: Pick<
    LaunchSynthesisRunOptions,
    | "workspaceId"
    | "triggerType"
    | "sourceItemIds"
    | "scheduledTaskId"
    | "occurrenceAt"
    | "retryOfRunId"
    | "client"
    | "now"
  >,
): Promise<string> {
  const client =
    options.client ?? (await import("../db/client")).serviceClient;

  await sweepStaleSynthesisRuns(client, { workspaceId: options.workspaceId });

  const { data: workspaceData, error: workspaceError } = await client
    .from("workspaces")
    .select("current_context_version_id, timezone")
    .eq("id", options.workspaceId)
    .single();
  if (workspaceError) throw workspaceError;
  const workspace = workspaceData as Pick<
    WorkspaceRow,
    "current_context_version_id" | "timezone"
  >;
  let baseContextVersionId = workspace.current_context_version_id;
  if (!baseContextVersionId) {
    // Workspace can be empty at first run. Memory is workspace
    // infrastructure, not an opt-in dimension, so its stubs are folded
    // straight into the seed insert rather than seeding {} and then
    // immediately provisioning a second version on top of it.
    const seedDocuments = computeMemoryAdditions({}, workspace.timezone, options.now);
    const { data: seededVersion, error: seedError } = await client
      .from("workspace_context_versions")
      .insert({
        workspace_id: options.workspaceId,
        version_number: 1,
        documents_json: seedDocuments,
        content_hash: canonicalDocumentsHash(seedDocuments),
        creation_reason: "seed",
        summary: "Empty workspace — no context yet",
      })
      .select("id")
      .single();
    if (seedError) throw seedError;
    baseContextVersionId = (seededVersion as { id: string }).id;

    const { error: pointerError } = await client
      .from("workspaces")
      .update({ current_context_version_id: baseContextVersionId })
      .eq("id", options.workspaceId);
    if (pointerError) throw pointerError;
  } else {
    const { data: versionData, error: versionError } = await client
      .from("workspace_context_versions")
      .select("documents_json, version_number")
      .eq("id", baseContextVersionId)
      .single();
    if (versionError) throw versionError;
    const version = versionData as Pick<
      WorkspaceContextVersionRow,
      "documents_json" | "version_number"
    >;

    // Memory is workspace infrastructure, not an opt-in dimension -- every
    // run ensures the current day/week/month files exist before the model
    // ever sees them (it can only rewrite pre-existing document paths, see
    // render-prompt.ts's allowedDocumentPaths).
    try {
      const provisioned = await ensureMemoryProvisioned({
        client,
        workspaceId: options.workspaceId,
        baseVersionId: baseContextVersionId,
        documents: version.documents_json,
        versionNumber: version.version_number,
        timezone: workspace.timezone,
        now: options.now,
      });
      baseContextVersionId = provisioned.baseContextVersionId;
    } catch (error) {
      // Recorded with its own code before rethrowing (launchSynthesisRun's
      // catch also records a generic synthesis_launch_preparation_failed) so
      // a provisioning failure is distinguishable from every other reason
      // prepareRun can fail during the same "preparation" stage.
      await recordError({
        client,
        workspaceId: options.workspaceId,
        operation: "queue",
        message: "Memory provisioning failed during prepareRun",
        code: "memory_provision_failed",
        detail: { baseContextVersionId, versionNumber: version.version_number },
        error,
      });
      throw error;
    }
  }

  const uniqueSourceItemIds = [...new Set(options.sourceItemIds)];
  if (uniqueSourceItemIds.length !== options.sourceItemIds.length) {
    throw new Error(
      "prepareRun: sourceItemIds must not contain duplicate IDs",
    );
  }

  let sourceItems: Pick<
    SourceItemRow,
    "id" | "external_version" | "content_hash"
  >[] = [];
  if (uniqueSourceItemIds.length > 0) {
    // Filtered by workspace+status, not by the id list itself -- both
    // callers already pass the full eligible set, and an .in() over that list
    // put every id in the request URL, which stops working once a
    // workspace's active set gets large enough (~600+ ids).
    const { data: activeItemsData, error: activeItemsError } = await client
      .from("source_items")
      .select("id, external_version, content_hash")
      .eq("workspace_id", options.workspaceId)
      .eq("lifecycle_status", "active");
    if (activeItemsError) throw activeItemsError;
    const activeById = new Map(
      ((activeItemsData ?? []) as typeof sourceItems).map((item) => [item.id, item]),
    );

    const ineligibleIds = uniqueSourceItemIds.filter((id) => !activeById.has(id));
    if (ineligibleIds.length > 0) {
      throw new Error(
        `Missing or ineligible source items while preparing run: ${ineligibleIds.join(", ")}`,
      );
    }
    sourceItems = uniqueSourceItemIds.map((id) => activeById.get(id)!);
  }

  // {scheduled_task_id}:{occurrence_at} so duplicate dispatches of the same
  // occurrence collide on one key; {trigger_type}:{uuid} otherwise.
  // retry:{failed_run_id} so a failed run gets at most one retry.
  if (!options.retryOfRunId && options.scheduledTaskId && !options.occurrenceAt) {
    throw new Error("prepareRun: scheduledTaskId requires occurrenceAt for a stable idempotency key");
  }
  const idempotencyKey = options.retryOfRunId
    ? `retry:${options.retryOfRunId}`
    : options.scheduledTaskId
      ? `${options.scheduledTaskId}:${options.occurrenceAt}`
      : `${options.triggerType}:${randomUUID()}`;

  // Counts consecutive failures: a failed latest run continues the streak,
  // anything else (success, no runs yet) starts a new one.
  const latestRun = await getLatestSynthesisRun(client, options.workspaceId);
  const attempt = latestRun?.status === "failed" ? latestRun.attempt + 1 : 1;

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
      base_context_version_id: baseContextVersionId,
      attempt,
      retry_of_run_id: options.retryOfRunId ?? null,
      prompt_version: PROMPT_VERSION,
    })
    .select("id")
    .single();
  if (runError) {
    // Checked by message, not just the 23505 code: the two constraints this
    // table can violate mean different things to the caller.
    if (runError.code === UNIQUE_VIOLATION) {
      if (runError.message.includes("synthesis_runs_one_active_writer")) {
        throw new WorkspaceRunAlreadyActiveError(options.workspaceId);
      }
      if (runError.message.includes("synthesis_runs_workspace_id_idempotency_key_key")) {
        throw new OccurrenceAlreadyDispatchedError(options.workspaceId, idempotencyKey);
      }
    }
    throw runError;
  }
  const runId = (runData as { id: string }).id;

  if (options.sourceItemIds.length > 0) {
    const sourceItemsById = new Map(
      sourceItems.map((item) => [item.id, item]),
    );

    const membershipRows = options.sourceItemIds.map((sourceItemId, position) => {
      const sourceItem = sourceItemsById.get(sourceItemId);
      // Eligibility was checked before creating the run row.
      if (!sourceItem) throw new Error(`Missing source item ${sourceItemId}`);
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
  const resolvedClient =
    client ?? (await import("../db/client")).serviceClient;

  const { error } = await resolvedClient
    .from("synthesis_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      sandbox_machine_id: receipt.machineId,
    })
    .eq("id", runId);
  if (error) throw error;
}
