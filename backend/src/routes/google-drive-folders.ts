import { serviceClient } from "../db/client";
import { driveAccessFor } from "../ingestion/google-drive/access";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { listDriveFolders, listDriveFolderOptions, addDriveFolder, removeDriveFolder } from "../ingestion/google-drive/folders-service";
export { listDriveFolders, listDriveFolderOptions, addDriveFolder, removeDriveFolder, type DriveFoldersDependencies } from "../ingestion/google-drive/folders-service";
type FoldersRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders">;
type FolderOptionsRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders/options">;
type FolderRequest = Bun.BunRequest<"/workspaces/:id/google/drive-folders/:folderId">;

const dependencies = { db: serviceClient, driveAccess: driveAccessFor, now: () => new Date() };

export const GET = withAuth<FoldersRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return listDriveFolders(req.params.id, caller.userId, dependencies);
});

export const FOLDER_OPTIONS_GET = withAuth<FolderOptionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const parent = new URL(req.url).searchParams.get("parent")?.trim() || "root";
  return listDriveFolderOptions(req.params.id, caller.userId, parent, dependencies);
});

export const POST = withAuth<FoldersRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  return addDriveFolder(req.params.id, caller.userId, body, dependencies);
});

export const DELETE = withAuth<FolderRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return removeDriveFolder(req.params.id, caller.userId, req.params.folderId, dependencies);
});
