import type { SupabaseClient } from "@supabase/supabase-js";
import { seedEmptyWorkspace } from "../synthesis/provision-memory";
import { loadCurrentContext } from "./context-store";

/** The context version a new run starts from: the current one, or a seed if the workspace has none yet. */
export async function resolveBaseContextVersionId(client: SupabaseClient, workspaceId: string): Promise<string> {
  const current = await loadCurrentContext(client, workspaceId);
  if (current.versionId) return current.versionId;
  const { data, error } = await client.from("workspaces").select("timezone").eq("id", workspaceId).single();
  if (error) throw error;
  return seedEmptyWorkspace(client, workspaceId, (data as { timezone: string }).timezone);
}
