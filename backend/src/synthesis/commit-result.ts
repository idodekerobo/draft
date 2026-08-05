import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalDocumentsHash } from "./context-version-files";
import type { ValidatedSynthesisResult } from "./types";
import type {
  SynthesisRunRow,
  WorkspaceContextVersionRow,
  WorkspaceRow,
} from "../types/tables";
import { insertEvent } from "../events/insert-event";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// TODO: sequential writes, not a transaction — accepted for this
// single-operator run. Wrap steps below in a real transaction/RPC once
// concurrent writers are possible.
export async function commitSynthesisResult(
  validated: ValidatedSynthesisResult,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: runData, error: runError } = await db
    .from("synthesis_runs")
    .select("id, workspace_id, base_context_version_id")
    .eq("id", validated.runId)
    .single();
  if (runError) throw runError;
  const run = runData as Pick<
    SynthesisRunRow,
    "id" | "workspace_id" | "base_context_version_id"
  >;

  // If the workspace's current pointer has moved since this run started,
  // someone else committed first -- writing on top of a stale base would
  // silently discard that commit.
  const { data: liveWorkspaceData, error: liveWorkspaceError } = await db
    .from("workspaces")
    .select("current_context_version_id")
    .eq("id", run.workspace_id)
    .single();
  if (liveWorkspaceError) throw liveWorkspaceError;
  const liveWorkspace = liveWorkspaceData as Pick<
    WorkspaceRow,
    "current_context_version_id"
  >;

  if (liveWorkspace.current_context_version_id !== run.base_context_version_id) {
    const message =
      `base version ${run.base_context_version_id} is no longer the ` +
      `workspace's current version (now ` +
      `${liveWorkspace.current_context_version_id}); another commit landed ` +
      `while this run was in flight.`;
    const { error: staleUpdateError } = await db
      .from("synthesis_runs")
      .update({
        status: "stale",
        outcome: "stale",
        result_summary: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    if (staleUpdateError) throw staleUpdateError;
    return;
  }

  if (validated.payload.outcome === "changed") {
    const { data: baseVersionData, error: baseVersionError } = await db
      .from("workspace_context_versions")
      .select("*")
      .eq("id", run.base_context_version_id)
      .single();
    if (baseVersionError) throw baseVersionError;
    const baseVersion = baseVersionData as WorkspaceContextVersionRow;

    const newDocuments = { ...baseVersion.documents_json };
    for (const [path, content] of Object.entries(validated.payload.documents)) {
      newDocuments[path] = { content, sha256: sha256(content) };
    }
    const newVersionNumber = Number(baseVersion.version_number) + 1;

    const { data: newVersionData, error: newVersionError } = await db
      .from("workspace_context_versions")
      .insert({
        workspace_id: run.workspace_id,
        version_number: newVersionNumber,
        previous_version_id: baseVersion.id,
        documents_json: newDocuments,
        content_hash: canonicalDocumentsHash(newDocuments),
        creation_reason: "synthesis",
        synthesis_run_id: run.id,
        summary: validated.payload.summary,
      })
      .select()
      .single();
    if (newVersionError) throw newVersionError;
    const newVersion = newVersionData as WorkspaceContextVersionRow;

    const { error: pointerError } = await db
      .from("workspaces")
      .update({ current_context_version_id: newVersion.id })
      .eq("id", run.workspace_id);
    if (pointerError) throw pointerError;

    await insertEvent(db, run.workspace_id, {
      event_type: "context_updated",
      synthesis_run_id: run.id,
      context_version_id: newVersion.id,
      summary: validated.payload.summary,
    });

    const { error: runUpdateError } = await db
      .from("synthesis_runs")
      .update({
        status: "succeeded",
        outcome: "changed",
        result_summary: validated.payload.summary,
        result_hash: newVersion.content_hash,
        needs_input_json: validated.payload.needs_input ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    if (runUpdateError) throw runUpdateError;
    return;
  }

  // outcome === "no_change"
  await insertEvent(db, run.workspace_id, {
    event_type: "no_change",
    synthesis_run_id: run.id,
    context_version_id: null,
    summary: validated.payload.summary,
  });

  const { error: runUpdateError } = await db
    .from("synthesis_runs")
    .update({
      status: "succeeded",
      outcome: "no_change",
      result_summary: validated.payload.summary,
      needs_input_json: validated.payload.needs_input ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  if (runUpdateError) throw runUpdateError;
}
