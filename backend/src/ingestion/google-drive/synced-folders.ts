import type { SupabaseClient } from "@supabase/supabase-js";

// Items stay after a disconnect; only the connection's synced Google Drive folders go, so
// another person can sync the same folders.
export async function removeAllSyncedGoogleDriveFolders(
  client: SupabaseClient,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const { error } = await client
    .from("synced_google_drive_folders")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId);
  if (error) throw error;
}
