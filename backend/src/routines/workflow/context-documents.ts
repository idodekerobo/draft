import type { SupabaseClient } from "@supabase/supabase-js";

/** The paths of the documents in the workspace's newest context version. */
export async function currentDocumentPaths(client: SupabaseClient, workspaceId: string): Promise<string[]> {
  const { data: workspace, error } = await client.from("workspaces").select("current_context_version_id").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  const versionId = (workspace as { current_context_version_id: string | null } | null)?.current_context_version_id;
  if (!versionId) return [];
  const { data: version, error: versionError } = await client.from("workspace_context_versions").select("documents_json").eq("id", versionId).maybeSingle();
  if (versionError) throw versionError;
  return Object.keys(((version as { documents_json: Record<string, unknown> } | null)?.documents_json) ?? {});
}
