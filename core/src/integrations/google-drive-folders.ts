// Maps the backend's /google/drive-folders bodies (snake_case) to the camelCase shapes web, desktop and the CLI share.

export interface SyncedGoogleDriveFolderView {
  id: string;
  folderKind: "folder" | "shared_drive";
  googleFolderId: string;
  name: string;
}

export interface SyncedGoogleDriveFoldersView {
  folders: SyncedGoogleDriveFolderView[];
  status: string | null;
  lastSuccessAt: string | null;
  reauthRequired: boolean;
}

export interface DriveFolderOptionView {
  folderKind: "folder" | "shared_drive";
  googleFolderId: string;
  name: string;
  synced: boolean;
  syncedByYou: boolean;
  syncedBy: string | null;
}

type Raw = Record<string, unknown>;

const kind = (value: unknown): "folder" | "shared_drive" => (value === "shared_drive" ? "shared_drive" : "folder");
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter((row): row is Raw => typeof row === "object" && row !== null) : []);

export function syncedFolderFromBody(row: Raw): SyncedGoogleDriveFolderView {
  return { id: text(row.id), folderKind: kind(row.folder_kind), googleFolderId: text(row.google_folder_id), name: text(row.name) };
}

export function syncedFoldersFromBody(body: unknown): SyncedGoogleDriveFoldersView {
  const raw = (body ?? {}) as Raw;
  return {
    folders: rows(raw.folders).map(syncedFolderFromBody),
    status: typeof raw.status === "string" ? raw.status : null,
    lastSuccessAt: typeof raw.last_success_at === "string" ? raw.last_success_at : null,
    reauthRequired: raw.reauth_required === true,
  };
}

export function folderOptionsFromBody(body: unknown): DriveFolderOptionView[] {
  return rows((body as Raw | null)?.options).map((row) => ({
    folderKind: kind(row.folder_kind),
    googleFolderId: text(row.google_folder_id),
    name: text(row.name),
    synced: row.synced === true,
    syncedByYou: row.synced_by_you === true,
    syncedBy: typeof row.synced_by === "string" ? row.synced_by : null,
  }));
}
