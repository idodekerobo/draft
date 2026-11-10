import type { SupabaseClient } from "@supabase/supabase-js";
import { seedEmptyWorkspace } from "../../synthesis/provision-memory";

/** The context version a new run starts from: the current one, or a seed if the workspace has none yet. */
export async function resolveBaseContextVersionId(client: SupabaseClient, workspaceId: string): Promise<string> {
  const { data, error } = await client.from("workspaces").select("current_context_version_id, timezone").eq("id", workspaceId).single();
  if (error) throw error;
  const workspace = data as { current_context_version_id: string | null; timezone: string };
  return workspace.current_context_version_id ?? seedEmptyWorkspace(client, workspaceId, workspace.timezone);
}
