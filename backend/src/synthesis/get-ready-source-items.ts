import type { SupabaseClient } from "@supabase/supabase-js";

// Tie-broken by id so ordering is deterministic when items share a timestamp.
export async function getReadySourceItemIds(
  workspaceId: string,
  client: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await client
    .from("source_items")
    .select("id, occurred_at")
    .eq("workspace_id", workspaceId)
    .eq("lifecycle_status", "ready")
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((item) => item.id);
}
