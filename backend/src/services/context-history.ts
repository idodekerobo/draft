import type { SupabaseClient } from "@supabase/supabase-js";

/** One version in which a document changed. */
export interface DocumentChange {
  versionId: string;
  versionNumber: number;
  createdAt: string;
  creationReason: string;
  agentRunId: string | null;
  summary: string;
}

/** When a document last changed, and which version did it. */
export interface DocumentLastChange extends DocumentChange {
  path: string;
}

/** How many of the newest versions the history functions read. Older changes are out of reach by design. */
export const CONTEXT_HISTORY_SCAN = 300;

interface HistoryRow {
  version_id: string;
  version_number: number | string;
  created_at: string;
  creation_reason: string;
  agent_run_id: string | null;
  summary: string;
}

const toChange = (row: HistoryRow): DocumentChange => ({
  versionId: row.version_id,
  versionNumber: Number(row.version_number),
  createdAt: row.created_at,
  creationReason: row.creation_reason,
  agentRunId: row.agent_run_id,
  summary: row.summary,
});

/** The versions that changed one document, newest first. */
export async function documentHistory(client: SupabaseClient, workspaceId: string, path: string, limit: number): Promise<DocumentChange[]> {
  const { data, error } = await client.rpc("context_document_history", { p_workspace_id: workspaceId, p_path: path, p_limit: limit, p_scan: CONTEXT_HISTORY_SCAN });
  if (error) throw new Error(error.message);
  return ((data ?? []) as HistoryRow[]).map(toChange);
}

/**
 * The last change of every document of the latest version, by path. A document with no entry did not change in the
 * versions that were read.
 */
export async function documentsLastChanged(client: SupabaseClient, workspaceId: string): Promise<Map<string, DocumentLastChange>> {
  const { data, error } = await client.rpc("context_documents_last_changed", { p_workspace_id: workspaceId, p_scan: CONTEXT_HISTORY_SCAN });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<HistoryRow & { path: string }>;
  return new Map(rows.map((row) => [row.path, { path: row.path, ...toChange({ ...row, summary: row.summary ?? "" }) }]));
}
