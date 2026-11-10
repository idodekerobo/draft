import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSafeDocumentPath, canonicalDocumentsHash, sha256, type ContextDocuments } from "../../synthesis/context-version-files";
import type { WorkspaceContextVersionRow } from "../../types/tables";

export type ContextCreationReason = "seed" | "memory_provision" | "agent_write" | "synthesis";

export interface CommitContextVersionInput {
  workspaceId: string;
  /** The version the caller read. The write only lands if it is still the current one. Null for a workspace with none. */
  expectedVersionId: string | null;
  documents: ContextDocuments;
  reason: ContextCreationReason;
  summary: string;
  agentRunId?: string | null;
}

export type CommitContextVersionResult =
  | { status: "committed"; versionId: string; versionNumber: number }
  | { status: "stale" };

/** The only place a context version is created outside synthesis. Every writer goes through here. */
export async function commitContextVersion(
  client: SupabaseClient,
  input: CommitContextVersionInput,
): Promise<CommitContextVersionResult> {
  const { data, error } = await client.rpc("commit_context_write", {
    p_workspace_id: input.workspaceId,
    p_expected_version_id: input.expectedVersionId,
    p_documents_json: input.documents,
    p_content_hash: canonicalDocumentsHash(input.documents),
    p_creation_reason: input.reason,
    p_summary: input.summary,
    p_agent_run_id: input.agentRunId ?? null,
  });
  if (error) throw error;
  const result = data as { status: "committed" | "stale"; new_version_id?: string; version_number?: number };
  if (result.status === "stale") return { status: "stale" };
  return { status: "committed", versionId: result.new_version_id!, versionNumber: Number(result.version_number) };
}

export interface CurrentContext {
  versionId: string | null;
  versionNumber: number;
  documents: ContextDocuments;
}

export async function loadVersionDocuments(client: SupabaseClient, versionId: string): Promise<ContextDocuments> {
  const { data, error } = await client.from("workspace_context_versions").select("documents_json").eq("id", versionId).single();
  if (error) throw error;
  return (data as Pick<WorkspaceContextVersionRow, "documents_json">).documents_json;
}

export async function loadCurrentContext(client: SupabaseClient, workspaceId: string): Promise<CurrentContext> {
  const { data: workspace, error } = await client.from("workspaces").select("current_context_version_id").eq("id", workspaceId).single();
  if (error) throw error;
  const versionId = (workspace as { current_context_version_id: string | null }).current_context_version_id;
  if (!versionId) return { versionId: null, versionNumber: 0, documents: {} };
  const { data: version, error: versionError } = await client
    .from("workspace_context_versions")
    .select("documents_json, version_number")
    .eq("id", versionId)
    .single();
  if (versionError) throw versionError;
  const row = version as Pick<WorkspaceContextVersionRow, "documents_json" | "version_number">;
  return { versionId, versionNumber: Number(row.version_number), documents: row.documents_json };
}

export const MAX_WRITE_DOCUMENT_BYTES = 200_000;
export const MAX_WRITE_TOTAL_BYTES = 4_000_000;
const MAX_STALE_RETRIES = 5;

export interface ContextChange {
  path: string;
  content: string;
  /**
   * The sha the writer based this change on. Omitted: the sha in the writer's base version.
   * Null: the writer expects the document not to exist.
   */
  baseSha?: string | null;
}

export interface ContextConflict {
  path: string;
  /** Null when the document does not exist now. */
  currentSha: string | null;
  currentContent: string | null;
  yourBaseSha: string | null;
}

export type WriteContextResult =
  /** Some or all changes landed in one version. `conflicts` holds the ones that did not. */
  | { status: "committed"; versionId: string; versionNumber: number; written: string[]; conflicts: ContextConflict[] }
  | { status: "unchanged" }
  | { status: "conflict"; currentVersionId: string | null; conflicts: ContextConflict[] };

export interface WriteContextInput {
  workspaceId: string;
  agentRunId: string;
  /** Where defaults for each change's base sha come from: the version the run started from. */
  baseVersionId: string;
  changes: ReadonlyArray<ContextChange>;
  summary: string;
  reason?: ContextCreationReason;
}

/**
 * Checks each changed document against what is current now, not the whole version.
 * A write to one document never fails because another document changed. Changes that do not
 * conflict land together in one version; the ones that conflict come back with the current content.
 */
export async function writeContext(client: SupabaseClient, input: WriteContextInput): Promise<WriteContextResult> {
  if (input.changes.length === 0) throw new Error("writeContext: no changes");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const change of input.changes) {
    assertSafeDocumentPath(change.path);
    if (paths.has(change.path)) throw new Error(`writeContext: duplicate path ${change.path}`);
    paths.add(change.path);
    const bytes = Buffer.byteLength(change.content);
    if (bytes > MAX_WRITE_DOCUMENT_BYTES) throw new Error(`writeContext: ${change.path} is too large`);
    totalBytes += bytes;
  }
  if (totalBytes > MAX_WRITE_TOTAL_BYTES) throw new Error(`writeContext: a write may hold at most ${MAX_WRITE_TOTAL_BYTES} bytes in all`);

  // The base version only supplies the default sha of a change that names none.
  const needsBase = input.changes.some((change) => change.baseSha === undefined);
  const baseDocuments = needsBase ? await loadVersionDocuments(client, input.baseVersionId) : {};

  for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
    const current = await loadCurrentContext(client, input.workspaceId);

    const conflicts: ContextConflict[] = [];
    const clean: ContextChange[] = [];
    for (const change of input.changes) {
      const yourBaseSha = change.baseSha !== undefined ? change.baseSha : (baseDocuments[change.path]?.sha256 ?? null);
      const currentDocument = current.documents[change.path];
      const currentSha = currentDocument?.sha256 ?? null;
      if (yourBaseSha !== currentSha) {
        conflicts.push({ path: change.path, currentSha, currentContent: currentDocument?.content ?? null, yourBaseSha });
      } else {
        clean.push(change);
      }
    }

    const changed = clean.filter((change) => current.documents[change.path]?.content !== change.content);
    if (changed.length === 0) {
      return conflicts.length > 0 ? { status: "conflict", currentVersionId: current.versionId, conflicts } : { status: "unchanged" };
    }

    const documents: ContextDocuments = { ...current.documents };
    for (const change of changed) documents[change.path] = { content: change.content, sha256: sha256(change.content) };

    const result = await commitContextVersion(client, {
      workspaceId: input.workspaceId,
      expectedVersionId: current.versionId,
      documents,
      reason: input.reason ?? "agent_write",
      summary: input.summary,
      agentRunId: input.agentRunId,
    });
    if (result.status === "committed") {
      return { status: "committed", versionId: result.versionId, versionNumber: result.versionNumber, written: changed.map((change) => change.path), conflicts };
    }
  }
  throw new Error("writeContext: the workspace context kept changing; try again");
}
