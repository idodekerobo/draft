import type { SupabaseClient } from "@supabase/supabase-js";

/** How many ids go in one request. An `.in()` over hundreds puts every id in the URL, which stops working. */
const IDS_PER_REQUEST = 100;

/** Source items of a workspace by id, read in chunks. An id with no item is left out. */
export async function loadSourceItemsByIds<T extends { id: string }>(client: SupabaseClient, workspaceId: string, ids: ReadonlyArray<string>, columns: string): Promise<Map<string, T>> {
  const items = new Map<string, T>();
  for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) {
    const { data, error } = await client.from("source_items").select(columns).eq("workspace_id", workspaceId).in("id", ids.slice(start, start + IDS_PER_REQUEST));
    if (error) throw error;
    for (const item of (data ?? []) as unknown as T[]) items.set(item.id, item);
  }
  return items;
}
