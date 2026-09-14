import type { SupabaseClient } from "@supabase/supabase-js";

export async function getPendingSynthesisSourceItemIds(
  workspaceId: string,
  client: SupabaseClient,
  options: { reprocess?: boolean } = {},
): Promise<string[]> {
  const { data, error } = await client.rpc("get_pending_synthesis_source_item_ids", {
    p_workspace_id: workspaceId,
    p_reprocess: options.reprocess ?? false,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ source_item_id: string }>).map((item) => item.source_item_id);
}
