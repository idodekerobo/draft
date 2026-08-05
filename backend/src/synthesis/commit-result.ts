import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalDocumentsHash } from "./context-version-files";
import type { ValidatedSynthesisResult } from "./types";
import type { SynthesisRunRow, WorkspaceContextVersionRow } from "../types/tables";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The merge below reads the base version outside any lock, which is safe:
// only one synthesis run is active per workspace at a time, so the base
// can't move before the RPC's own locked re-check runs.
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

  let documentsJson: WorkspaceContextVersionRow["documents_json"] | null = null;
  let contentHash: string | null = null;

  if (validated.payload.outcome === "changed") {
    const { data: baseVersionData, error: baseVersionError } = await db
      .from("workspace_context_versions")
      .select("documents_json")
      .eq("id", run.base_context_version_id)
      .single();
    if (baseVersionError) throw baseVersionError;
    const baseVersion = baseVersionData as Pick<
      WorkspaceContextVersionRow,
      "documents_json"
    >;

    const newDocuments = { ...baseVersion.documents_json };
    for (const [path, content] of Object.entries(validated.payload.documents)) {
      newDocuments[path] = { content, sha256: sha256(content) };
    }
    documentsJson = newDocuments;
    contentHash = canonicalDocumentsHash(newDocuments);
  }

  const { error: rpcError } = await db.rpc("commit_synthesis_run", {
    p_run_id: run.id,
    p_outcome: validated.payload.outcome,
    p_summary: validated.payload.summary,
    p_documents_json: documentsJson,
    p_content_hash: contentHash,
    p_needs_input_json: validated.payload.needs_input ?? null,
  });
  if (rpcError) throw rpcError;
}
