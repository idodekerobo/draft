import type { SupabaseClient } from "@supabase/supabase-js";
import { DriveApiError, type DriveApi, type DriveFile } from "./api";

export type SyncedGoogleDriveFolderKind = "folder" | "shared_drive";

export interface SyncedGoogleDriveFolder {
  id: string;
  folderKind: SyncedGoogleDriveFolderKind;
  googleFolderId: string;
  name: string;
  connectionId: string;
}

export interface SyncedGoogleDriveFolderInput {
  folderKind: SyncedGoogleDriveFolderKind;
  googleFolderId: string;
  name: string;
}

export type AddSyncedGoogleDriveFolderResult =
  | { ok: true; folder: SyncedGoogleDriveFolder }
  | { ok: false; code: "drive_folder_already_synced"; message: string; ownerName: string | null };

interface FolderRow {
  id: string;
  folder_kind: SyncedGoogleDriveFolderKind;
  google_folder_id: string;
  name: string;
  connection_id: string;
}

const FOLDER_COLUMNS = "id, folder_kind, google_folder_id, name, connection_id";
const MAX_ANCESTOR_DEPTH = 20;

const toFolder = (row: FolderRow): SyncedGoogleDriveFolder => ({
  id: row.id,
  folderKind: row.folder_kind,
  googleFolderId: row.google_folder_id,
  name: row.name,
  connectionId: row.connection_id,
});

export async function listSyncedGoogleDriveFolders(
  client: SupabaseClient,
  workspaceId: string,
  connectionId?: string,
): Promise<SyncedGoogleDriveFolder[]> {
  let query = client.from("synced_google_drive_folders").select(FOLDER_COLUMNS).eq("workspace_id", workspaceId);
  if (connectionId) query = query.eq("connection_id", connectionId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as FolderRow[]).map(toFolder);
}

// The unique key on (workspace_id, google_folder_id) is the one-owner rule.
export async function addSyncedGoogleDriveFolder(
  client: SupabaseClient,
  workspaceId: string,
  connectionId: string,
  input: SyncedGoogleDriveFolderInput,
): Promise<AddSyncedGoogleDriveFolderResult> {
  const { data, error } = await client
    .from("synced_google_drive_folders")
    .insert({
      workspace_id: workspaceId,
      connection_id: connectionId,
      folder_kind: input.folderKind,
      google_folder_id: input.googleFolderId,
      name: input.name,
    })
    .select(FOLDER_COLUMNS)
    .single();
  if (!error) return { ok: true, folder: toFolder(data as FolderRow) };
  if ((error as { code?: string }).code !== "23505") throw error;

  const { data: existing, error: existingError } = await client
    .from("synced_google_drive_folders")
    .select("connection_id")
    .eq("workspace_id", workspaceId)
    .eq("google_folder_id", input.googleFolderId)
    .maybeSingle<{ connection_id: string }>();
  if (existingError) throw existingError;
  let ownerName: string | null = null;
  if (existing) {
    const { data: owner, error: ownerError } = await client
      .from("connections")
      .select("display_name")
      .eq("id", existing.connection_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle<{ display_name: string | null }>();
    if (ownerError) throw ownerError;
    ownerName = owner?.display_name ?? null;
  }
  return {
    ok: false,
    code: "drive_folder_already_synced",
    message: `Already synced by ${ownerName ?? "a teammate"}.`,
    ownerName,
  };
}

// Returns false when the row does not exist or another connection owns it.
export async function removeSyncedGoogleDriveFolder(
  client: SupabaseClient,
  workspaceId: string,
  connectionId: string,
  folderId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("synced_google_drive_folders")
    .delete()
    .eq("id", folderId)
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

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

export interface FolderMatch {
  folder: SyncedGoogleDriveFolder;
  // Folder names from the synced folder down to the file's parent.
  path: string[];
}

export interface FolderResolver {
  match(file: DriveFile): Promise<FolderMatch | null>;
  contains(file: DriveFile): Promise<boolean>;
}

export type DriveFileCache = Map<string, DriveFile | null>;

// Walks a file's parents with getFile. Pass one cache per sync run so each folder is read once.
export function createFolderResolver(
  api: DriveApi,
  folders: SyncedGoogleDriveFolder[],
  cache: DriveFileCache = new Map(),
): FolderResolver {
  const byGoogleId = new Map(folders.map((folder) => [folder.googleFolderId, folder]));

  async function load(id: string): Promise<DriveFile | null> {
    if (cache.has(id)) return cache.get(id)!;
    let file: DriveFile | null = null;
    try {
      file = await api.getFile(id);
    } catch (error) {
      if (!(error instanceof DriveApiError) || (error.code !== "forbidden" && error.code !== "not_found")) throw error;
    }
    cache.set(id, file);
    return file;
  }

  async function match(file: DriveFile): Promise<FolderMatch | null> {
    const sharedDrive = file.driveId ? byGoogleId.get(file.driveId) : undefined;
    const path: string[] = [];
    let parentId = file.parents?.[0];
    for (let depth = 0; parentId && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      const folder = byGoogleId.get(parentId);
      if (folder) return { folder, path };
      if (sharedDrive && parentId === sharedDrive.googleFolderId) break;
      const parent = await load(parentId);
      if (!parent) break;
      path.unshift(parent.name ?? "");
      parentId = parent.parents?.[0];
    }
    return sharedDrive ? { folder: sharedDrive, path } : null;
  }

  return { match, contains: async (file) => (await match(file)) !== null };
}

// True when a synced Google Drive folder of any live Drive connection in the workspace holds the file.
export async function workspaceContains(
  client: SupabaseClient,
  workspaceId: string,
  api: DriveApi,
  file: DriveFile,
  cache?: DriveFileCache,
): Promise<boolean> {
  const folders = await listLiveWorkspaceFolders(client, workspaceId);
  if (folders.length === 0) return false;
  return createFolderResolver(api, folders, cache).contains(file);
}

export async function listLiveWorkspaceFolders(client: SupabaseClient, workspaceId: string): Promise<SyncedGoogleDriveFolder[]> {
  const { data, error } = await client
    .from("connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "google_drive")
    .in("status", ["active", "degraded"]);
  if (error) throw error;
  const live = new Set(((data ?? []) as Array<{ id: string }>).map((row) => row.id));
  if (live.size === 0) return [];
  return (await listSyncedGoogleDriveFolders(client, workspaceId)).filter((folder) => live.has(folder.connectionId));
}
