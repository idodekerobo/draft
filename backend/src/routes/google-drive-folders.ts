import type { SupabaseClient } from "@supabase/supabase-js";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { driveAccessFor } from "../ingestion/google-drive/access";
import { DriveApiError, FOLDER_MIME, type DriveFile } from "../ingestion/google-drive/api";
import {
  addSyncedGoogleDriveFolder,
  listSyncedGoogleDriveFolders,
  removeSyncedGoogleDriveFolder,
  type SyncedGoogleDriveFolderKind,
} from "../ingestion/google-drive/synced-folders";

type FoldersRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders">;
type FolderOptionsRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders/options">;
type FolderRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders/:folderId">;

export interface DriveFoldersDependencies {
  db: SupabaseClient;
  driveAccess: typeof driveAccessFor;
  now: () => Date;
}

const defaultDependencies: DriveFoldersDependencies = { db: serviceClient, driveAccess: driveAccessFor, now: () => new Date() };

interface DriveConnectionRow {
  id: string;
  status: string;
  last_success_at: string | null;
  cursor_json: Record<string, unknown> | null;
}

function errorResponse(error: string, status: number, detail?: unknown, workspaceId?: string, message?: string): Response {
  if (status >= 500) recordRouteError({ workspaceId: workspaceId ?? null, operation: "read", errorCode: error, error: detail });
  return Response.json(message ? { error, message } : { error }, { status });
}

// Synced Google Drive folders belong to the caller's own Drive connection, so only that person may change them.
async function callerConnection(db: SupabaseClient, workspaceId: string, userId: string): Promise<DriveConnectionRow | null> {
  const { data, error } = await db
    .from("connections")
    .select("id, status, last_success_at, cursor_json")
    .eq("workspace_id", workspaceId)
    .eq("provider", "google_drive")
    .eq("connected_by_user_id", userId)
    .in("status", ["active", "degraded"])
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as DriveConnectionRow[])[0] ?? null;
}

const notConnected = () => errorResponse("drive_not_connected", 404);

export async function listDriveFolders(workspaceId: string, userId: string, deps = defaultDependencies): Promise<Response> {
  try {
    const connection = await callerConnection(deps.db, workspaceId, userId);
    if (!connection) return notConnected();
    const folders = await listSyncedGoogleDriveFolders(deps.db, workspaceId, connection.id);
    return Response.json({
      folders: folders.map((folder) => ({
        id: folder.id,
        folder_kind: folder.folderKind,
        google_folder_id: folder.googleFolderId,
        name: folder.name,
      })),
      status: connection.status,
      reauth_required: connection.cursor_json?.reauth_required === true,
      last_success_at: connection.last_success_at,
    });
  } catch (error) {
    return errorResponse("drive_folders_lookup_failed", 500, error, workspaceId);
  }
}

export async function listDriveFolderOptions(
  workspaceId: string,
  userId: string,
  parent: string,
  deps = defaultDependencies,
): Promise<Response> {
  try {
    const access = await deps.driveAccess(deps.db, workspaceId, userId);
    if (!access.ok) return errorResponse(access.code, access.code === "drive_not_connected" ? 404 : 409, undefined, workspaceId, access.message);

    let options: Array<{ folder_kind: SyncedGoogleDriveFolderKind; google_folder_id: string; name: string }>;
    if (parent === "shared") {
      const drives = await access.api.listSharedDrives();
      options = drives.map((drive) => ({ folder_kind: "shared_drive", google_folder_id: drive.id, name: drive.name }));
    } else {
      const children: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const page = await access.api.listFolderChildren(parent, pageToken);
        children.push(...page.files);
        pageToken = page.nextPageToken;
      } while (pageToken);
      options = children
        .filter((file) => file.mimeType === FOLDER_MIME)
        .map((file) => ({ folder_kind: "folder", google_folder_id: file.id, name: file.name ?? "Untitled folder" }));
    }

    const synced = await listSyncedGoogleDriveFolders(deps.db, workspaceId);
    const ownerNames = await connectionNames(deps.db, workspaceId, [...new Set(synced.map((folder) => folder.connectionId))]);
    const callerConn = await callerConnection(deps.db, workspaceId, userId);
    const byGoogleId = new Map(synced.map((folder) => [folder.googleFolderId, folder]));
    return Response.json({
      options: options.map((option) => {
        const folder = byGoogleId.get(option.google_folder_id);
        return {
          ...option,
          synced: Boolean(folder),
          synced_by_you: Boolean(folder && folder.connectionId === callerConn?.id),
          synced_by: folder ? ownerNames.get(folder.connectionId) ?? null : null,
        };
      }),
    });
  } catch (error) {
    return errorResponse("drive_folder_options_failed", 502, error, workspaceId);
  }
}

async function connectionNames(db: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("connections").select("id, display_name").eq("workspace_id", workspaceId).in("id", ids);
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; display_name: string | null }>).map((row) => [row.id, row.display_name]));
}

function parseAddBody(body: unknown): { folderKind: SyncedGoogleDriveFolderKind; googleFolderId: string; name: string } | null {
  if (!body || typeof body !== "object") return null;
  const { folderKind, googleFolderId, name } = body as Record<string, unknown>;
  if (folderKind !== "folder" && folderKind !== "shared_drive") return null;
  if (typeof googleFolderId !== "string" || !googleFolderId.trim()) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  return { folderKind, googleFolderId: googleFolderId.trim(), name: name.trim() };
}

export async function addDriveFolder(workspaceId: string, userId: string, body: unknown, deps = defaultDependencies): Promise<Response> {
  let input = parseAddBody(body);
  const raw = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const resolveId = raw && Object.keys(raw).length === 1 && typeof raw.googleFolderId === "string" ? raw.googleFolderId.trim() : null;
  if (!input && !resolveId) return errorResponse("invalid_body", 400);
  try {
    const connection = await callerConnection(deps.db, workspaceId, userId);
    if (!connection) return notConnected();
    if (!input) {
      const access = await deps.driveAccess(deps.db, workspaceId, userId);
      if (!access.ok) return errorResponse(access.code, access.code === "drive_not_connected" ? 404 : 409);
      const file = await access.api.getFile(resolveId!);
      if (file.mimeType !== FOLDER_MIME || file.trashed) return errorResponse("drive_not_a_folder", 400);
      input = { googleFolderId: file.id, folderKind: file.driveId === file.id ? "shared_drive" : "folder", name: file.name ?? "Untitled folder" };
    }
    const result = await addSyncedGoogleDriveFolder(deps.db, workspaceId, connection.id, input);
    if (!result.ok) {
      return Response.json({ error: result.code, message: result.message, synced_by: result.ownerName }, { status: 409 });
    }

    // The sync sees the new folder row and starts its backfill; run it on the next tick.
    const { error: taskError } = await deps.db
      .from("scheduled_tasks")
      .update({ next_due_at: deps.now().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("task_type", "ingest_source")
      .eq("task_key", connection.id);
    if (taskError) throw taskError;

    const { folder } = result;
    return Response.json(
      { folder: { id: folder.id, folder_kind: folder.folderKind, google_folder_id: folder.googleFolderId, name: folder.name } },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DriveApiError) return errorResponse(error.code === "not_found" ? "not_found" : "drive_folder_lookup_failed", error.status);
    return errorResponse("drive_folder_add_failed", 500, error, workspaceId);
  }
}

export async function removeDriveFolder(workspaceId: string, userId: string, folderId: string, deps = defaultDependencies): Promise<Response> {
  try {
    const connection = await callerConnection(deps.db, workspaceId, userId);
    if (!connection) return notConnected();
    if (await removeSyncedGoogleDriveFolder(deps.db, workspaceId, connection.id, folderId)) return Response.json({ ok: true });

    const { data, error } = await deps.db
      .from("synced_google_drive_folders")
      .select("id")
      .eq("id", folderId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    return data ? errorResponse("not_folder_owner", 403) : errorResponse("not_found", 404);
  } catch (error) {
    return errorResponse("drive_folder_remove_failed", 500, error, workspaceId);
  }
}

export const GET = withAuth<FoldersRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return listDriveFolders(req.params.id, caller.userId);
});

export const FOLDER_OPTIONS_GET = withAuth<FolderOptionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const parent = new URL(req.url).searchParams.get("parent")?.trim() || "root";
  return listDriveFolderOptions(req.params.id, caller.userId, parent);
});

export const POST = withAuth<FoldersRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", 400);
  }
  return addDriveFolder(req.params.id, caller.userId, body);
});

export const DELETE = withAuth<FolderRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return removeDriveFolder(req.params.id, caller.userId, req.params.folderId);
});
