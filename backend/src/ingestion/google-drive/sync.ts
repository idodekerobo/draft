import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../config";
import { CredentialError, resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import { recordRouteError } from "../../errors/route-error";
import { GoogleOAuthError, refreshGoogleAccessToken } from "../google/oauth";
import { createDriveApi, DriveApiError, FOLDER_MIME, NATIVE_MIME_TYPES, type DriveApi, type DriveChange, type DriveFile } from "./api";
import { renderDriveFile, sheetReadsFor, type RenderedFile } from "./render-file";
import {
  createFolderResolver,
  listLiveWorkspaceFolders,
  listSyncedGoogleDriveFolders,
  type DriveFileCache,
  type FolderMatch,
  type FolderResolver,
  type SyncedGoogleDriveFolder,
} from "./synced-folders";

export const BACKFILL_DAYS = 90;
export const MAX_BACKFILL_FILES = 500;
export const MAX_FILES_PER_POLL = 100;
const MAX_CHANGE_PAGES = 20;
const MAX_LIST_PAGES_PER_POLL = 50;
const MAX_DEFERRED = 200;
const RECENT_COMMENT_DAYS = 7;
const COMMENT_REFRESH_PER_POLL = 5;
const SHEET_READS_PER_MINUTE = 50;
// A disconnect during a poll must win over the poll's final status write.
const LIVE_STATUSES = ["active", "degraded"];

export interface DriveSyncConnection {
  id: string;
  workspace_id: string;
}

export type DriveSkipReason = "forbidden" | "render_failed";

export interface DriveSyncDependencies {
  settings: () => GoogleOAuthSettings | null;
  refreshAccessToken: typeof refreshGoogleAccessToken;
  createApi: (accessToken: string) => DriveApi;
  now: () => Date;
  recordSkip: (connection: DriveSyncConnection, fileId: string, reason: DriveSkipReason, error: unknown) => void;
}

const defaultDependencies: DriveSyncDependencies = {
  settings: googleOAuthSettings,
  refreshAccessToken: refreshGoogleAccessToken,
  createApi: (accessToken) => createDriveApi(accessToken),
  now: () => new Date(),
  recordSkip: (connection, fileId, reason, error) =>
    recordRouteError({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      operation: "ingestion",
      errorCode: `drive_file_${reason}`,
      detail: { file_id: fileId },
      error,
    }),
};

interface FolderBackfill {
  page_token?: string;
  // Folders still to list, breadth first. Unused for a shared drive.
  queue?: string[];
  done?: boolean;
}

export interface DriveCursor {
  // Changes feed position, taken before the first backfill.
  start_page_token?: string;
  // Set when a poll stopped partway through a changes page run.
  change_page_token?: string;
  // Keyed by Google folder id. A folder missing from the map has not started its backfill.
  backfill?: { seen: number; folders: Record<string, FolderBackfill> };
  // Files skipped because the Sheets read budget ran out.
  deferred_file_ids?: string[];
  // Last file id whose comments were refreshed; the next poll continues after it.
  comment_refresh_after?: string;
  // Resume checking captured files after a synced folder is removed.
  folder_cleanup_after?: string | null;
  reauth_required?: boolean;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  status: string;
  credential_id: string | null;
  cursor_json: DriveCursor | null;
  connected_by_user_id: string | null;
}

// Sheets allows 60 reads per minute per user; stay under it across polls.
const sheetReadLog = new Map<string, number[]>();

function takeSheetReads(connectionId: string, count: number, nowMs: number): boolean {
  const recent = (sheetReadLog.get(connectionId) ?? []).filter((at) => nowMs - at < 60_000);
  if (recent.length + count > SHEET_READS_PER_MINUTE) {
    sheetReadLog.set(connectionId, recent);
    return false;
  }
  for (let i = 0; i < count; i += 1) recent.push(nowMs);
  sheetReadLog.set(connectionId, recent);
  return true;
}

export function resetSheetThrottle(): void {
  sheetReadLog.clear();
}

function windowStart(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

const isNativeMime = (file: DriveFile) => Boolean(file.mimeType && NATIVE_MIME_TYPES.includes(file.mimeType));
const isDriveError = (error: unknown, ...codes: DriveApiError["code"][]) => error instanceof DriveApiError && codes.includes(error.code);

interface PassContext {
  connection: DriveSyncConnection;
  ownerUserId: string | null;
  api: DriveApi;
  client: SupabaseClient;
  deps: DriveSyncDependencies;
  resolver: FolderResolver;
  fileCache: DriveFileCache;
  handled: Set<string>;
  deferred: Set<string>;
  now: Date;
}

async function hasStoredRows(ctx: PassContext, fileId: string): Promise<boolean> {
  const { data, error } = await ctx.client
    .from("source_items")
    .select("id")
    .eq("workspace_id", ctx.connection.workspace_id)
    .eq("external_id", fileId)
    .neq("lifecycle_status", "deleted")
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

async function deleteFile(ctx: PassContext, fileId: string): Promise<void> {
  const { error } = await ctx.client.rpc("delete_drive_file", { p_workspace_id: ctx.connection.workspace_id, p_external_id: fileId });
  if (error) throw error;
}

async function capturedByOtherConnection(ctx: PassContext, fileId: string): Promise<boolean> {
  const { data, error } = await ctx.client
    .from("source_items")
    .select("connection_id")
    .eq("workspace_id", ctx.connection.workspace_id)
    .eq("external_id", fileId)
    .neq("connection_id", ctx.connection.id)
    .neq("lifecycle_status", "deleted");
  if (error) throw error;
  const ids = [...new Set(((data ?? []) as Array<{ connection_id: string }>).map((row) => row.connection_id))];
  if (ids.length === 0) return false;
  const { data: live, error: liveError } = await ctx.client
    .from("connections")
    .select("id")
    .in("id", ids)
    .in("status", LIVE_STATUSES);
  if (liveError) throw liveError;
  return ((live ?? []) as unknown[]).length > 0;
}

// This connection's folders no longer hold the file. Another live connection that captured it decides
// for itself, and a teammate's folder this login cannot fully see may still hold it.
async function deleteUnlessHeldElsewhere(ctx: PassContext, file: DriveFile, others: SyncedGoogleDriveFolder[]): Promise<void> {
  if (await capturedByOtherConnection(ctx, file.id)) return;
  if (others.length > 0 && (await createFolderResolver(ctx.api, others, ctx.fileCache).holds(file)) !== "no") return;
  await deleteFile(ctx, file.id);
}

async function otherConnectionsFolders(ctx: PassContext): Promise<SyncedGoogleDriveFolder[]> {
  const folders = await listLiveWorkspaceFolders(ctx.client, ctx.connection.workspace_id);
  return folders.filter((folder) => folder.connectionId !== ctx.connection.id);
}

// This person can no longer see the file (removed from their view or 404), so this connection
// cannot tell whether a teammate's synced folder still holds it. It is kept while any other
// live Drive connection has synced folders; that connection sees its own changes.
async function handleGone(ctx: PassContext, fileId: string): Promise<void> {
  if (!(await hasStoredRows(ctx, fileId))) return;
  if ((await otherConnectionsFolders(ctx)).length > 0) return;
  await deleteFile(ctx, fileId);
}

async function processFile(ctx: PassContext, file: DriveFile, match: FolderMatch): Promise<void> {
  const reads = sheetReadsFor(file.mimeType);
  if (reads > 0 && !takeSheetReads(ctx.connection.id, reads, ctx.now.getTime())) {
    if (ctx.deferred.size < MAX_DEFERRED) ctx.deferred.add(file.id);
    return;
  }
  ctx.deferred.delete(file.id);

  let rendered;
  try {
    rendered = await renderDriveFile(ctx.api, file);
  } catch (error) {
    if (isDriveError(error, "not_found")) return handleGone(ctx, file.id);
    if (isDriveError(error, "unauthorized", "rate_limited")) throw error;
    ctx.deps.recordSkip(ctx.connection, file.id, isDriveError(error, "forbidden") ? "forbidden" : "render_failed", error);
    return;
  }
  if (!rendered) return;

  await writeDriveFile(ctx.client, {
    workspaceId: ctx.connection.workspace_id,
    connectionId: ctx.connection.id,
    ownerUserId: ctx.ownerUserId,
    file,
    rendered,
    folderPath: [match.folder.name, ...match.path].join("/"),
    now: ctx.now,
  });
}

export function driveVersionKey(rendered: RenderedFile): string {
  return createHash("sha256").update(`${rendered.markdown}:${rendered.commentsHash}`).digest("hex").slice(0, 32);
}

export interface DriveFileWrite {
  workspaceId: string;
  connectionId: string;
  ownerUserId: string | null;
  file: DriveFile;
  rendered: RenderedFile;
  folderPath: string | null;
  now: Date;
}

// Sync and live reads both store a file through here, so a version key means the same thing in both.
export async function writeDriveFile(client: SupabaseClient, write: DriveFileWrite): Promise<{ item_id: string; changed: boolean }> {
  const { file, rendered } = write;
  const { data, error } = await client.rpc("write_drive_source_item", {
    p_workspace_id: write.workspaceId,
    p_connection_id: write.connectionId,
    p_item_type: "document",
    p_external_id: file.id,
    p_external_version: driveVersionKey(rendered),
    p_occurred_at: file.modifiedTime ?? write.now.toISOString(),
    p_content_markdown: rendered.markdown,
    p_content_hash: createHash("sha256").update(rendered.markdown).digest("hex"),
    p_metadata_json: {
      title: file.name ?? null,
      file_id: file.id,
      mime_type: file.mimeType ?? null,
      drive_id: file.driveId ?? null,
      folder_path: write.folderPath,
      web_view_link: file.webViewLink ?? null,
      modified_time: file.modifiedTime ?? null,
      last_modified_by: file.lastModifyingUser?.displayName ?? null,
      comments_hash: rendered.commentsHash,
      truncated: rendered.truncated,
    },
    p_sanitized_raw_json: rendered.structured,
    p_visibility: "shared",
    p_owner_user_id: write.ownerUserId,
    p_representation_kind: "source",
  });
  if (error) throw error;
  return data as { item_id: string; changed: boolean };
}

// Returns true when the file was rendered or deferred, so callers can count it against the poll budget.
async function handleFile(ctx: PassContext, change: DriveChange): Promise<boolean> {
  const file = change.file;
  if (change.removed || !file) {
    await handleGone(ctx, change.fileId);
    return false;
  }
  if (!isNativeMime(file)) return false;
  if (file.trashed) {
    if (await hasStoredRows(ctx, file.id)) await deleteFile(ctx, file.id);
    return false;
  }
  const match = await ctx.resolver.match(file);
  if (match) {
    ctx.handled.add(file.id);
    await processFile(ctx, file, match);
    return true;
  }
  if (await hasStoredRows(ctx, file.id)) await deleteUnlessHeldElsewhere(ctx, file, await otherConnectionsFolders(ctx));
  return false;
}

async function cleanRemovedFolders(ctx: PassContext, after: string | null): Promise<string | undefined> {
  let query = ctx.client.from("source_items")
    .select("id, external_id")
    .eq("workspace_id", ctx.connection.workspace_id)
    .eq("connection_id", ctx.connection.id)
    .eq("lifecycle_status", "active")
    .order("id", { ascending: true })
    .limit(MAX_FILES_PER_POLL);
  if (after) query = query.gt("id", after);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; external_id: string }>;
  const others = await otherConnectionsFolders(ctx);
  for (const row of rows) {
    try {
      const file = await ctx.api.getFile(row.external_id);
      if (file.trashed) await deleteFile(ctx, row.external_id);
      else if (!(await ctx.resolver.contains(file))) await deleteUnlessHeldElsewhere(ctx, file, others);
    } catch (fileError) {
      if (isDriveError(fileError, "not_found")) await handleGone(ctx, row.external_id);
      else if (isDriveError(fileError, "forbidden")) ctx.deps.recordSkip(ctx.connection, row.external_id, "forbidden", fileError);
      else throw fileError;
    }
  }
  return rows.length === MAX_FILES_PER_POLL ? rows[rows.length - 1]!.id : undefined;
}

async function backfillPass(ctx: PassContext, folders: SyncedGoogleDriveFolder[], cursor: DriveCursor): Promise<DriveCursor["backfill"]> {
  const previous = cursor.backfill ?? { seen: 0, folders: {} };
  const state: NonNullable<DriveCursor["backfill"]> = { seen: previous.seen, folders: {} };
  for (const folder of folders) state.folders[folder.googleFolderId] = { ...(previous.folders[folder.googleFolderId] ?? {}) };

  const since = windowStart(ctx.now, BACKFILL_DAYS);
  const nativeQuery = `modifiedTime > '${since}' and trashed = false and (${NATIVE_MIME_TYPES.map((mime) => `mimeType = '${mime}'`).join(" or ")})`;
  let processed = 0;
  let pages = 0;

  for (const folder of folders) {
    const progress = state.folders[folder.googleFolderId]!;
    while (!progress.done) {
      if (state.seen >= MAX_BACKFILL_FILES) {
        progress.done = true;
        break;
      }
      if (processed >= MAX_FILES_PER_POLL || pages >= MAX_LIST_PAGES_PER_POLL) return state;
      pages += 1;

      let files: DriveFile[];
      if (folder.folderKind === "shared_drive") {
        const page = await ctx.api.listFiles({ q: nativeQuery, driveId: folder.googleFolderId, pageToken: progress.page_token });
        files = page.files;
        progress.page_token = page.nextPageToken;
        if (!page.nextPageToken) progress.done = true;
      } else {
        const queue = progress.queue ?? [folder.googleFolderId];
        const page = await ctx.api.listFolderChildren(queue[0]!, progress.page_token);
        for (const child of page.files) if (child.mimeType === FOLDER_MIME) queue.push(child.id);
        files = page.files.filter((file) => isNativeMime(file) && !file.trashed && (file.modifiedTime ?? "") > since);
        if (page.nextPageToken) {
          progress.page_token = page.nextPageToken;
        } else {
          queue.shift();
          delete progress.page_token;
        }
        progress.queue = queue;
        if (queue.length === 0) {
          progress.done = true;
          delete progress.queue;
        }
      }

      for (const file of files.slice(0, MAX_BACKFILL_FILES - state.seen)) {
        if (ctx.handled.has(file.id)) continue;
        const match = await ctx.resolver.match(file);
        if (!match) continue;
        ctx.handled.add(file.id);
        await processFile(ctx, file, match);
        state.seen += 1;
        processed += 1;
      }
    }
  }
  return state;
}

async function changesPass(ctx: PassContext, cursor: DriveCursor): Promise<Pick<DriveCursor, "start_page_token" | "change_page_token">> {
  const startToken = cursor.start_page_token!;
  let pageToken: string | undefined = cursor.change_page_token ?? startToken;
  let processed = 0;

  for (let page = 0; page < MAX_CHANGE_PAGES && pageToken; page += 1) {
    const result = await ctx.api.listChanges(pageToken);
    for (const change of result.changes) if (await handleFile(ctx, change)) processed += 1;
    if (result.newStartPageToken) return { start_page_token: result.newStartPageToken };
    pageToken = result.nextPageToken;
    if (processed >= MAX_FILES_PER_POLL) break;
  }
  return { start_page_token: startToken, change_page_token: pageToken };
}

// A new comment does not reliably change a file's modified time, so recently edited files are
// re-read a few at a time, in file id order, wrapping around.
async function refreshRecentComments(ctx: PassContext, after: string | undefined): Promise<string | undefined> {
  let query = ctx.client
    .from("source_items")
    .select("external_id")
    .eq("workspace_id", ctx.connection.workspace_id)
    .eq("connection_id", ctx.connection.id)
    .eq("lifecycle_status", "active")
    .gt("occurred_at", windowStart(ctx.now, RECENT_COMMENT_DAYS));
  if (after) query = query.gt("external_id", after);
  const { data, error } = await query.order("external_id", { ascending: true }).limit(COMMENT_REFRESH_PER_POLL);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ external_id: string }>;

  for (const row of rows) {
    if (ctx.handled.has(row.external_id)) continue;
    let file: DriveFile;
    try {
      file = await ctx.api.getFile(row.external_id);
    } catch (fileError) {
      if (isDriveError(fileError, "not_found")) await handleGone(ctx, row.external_id);
      else if (!isDriveError(fileError, "forbidden")) throw fileError;
      continue;
    }
    await handleFile(ctx, { fileId: file.id, file });
  }
  return rows.length < COMMENT_REFRESH_PER_POLL ? undefined : rows.at(-1)?.external_id;
}

async function markNeedsReconnect(connection: DriveSyncConnection, cursor: DriveCursor, client: SupabaseClient, now: Date) {
  const { error } = await client
    .from("connections")
    .update({ status: "degraded", last_error_at: now.toISOString(), cursor_json: { ...cursor, reauth_required: true } })
    .eq("id", connection.id)
    .eq("workspace_id", connection.workspace_id)
    .in("status", LIVE_STATUSES);
  if (error) throw error;
}

export async function syncDriveConnection(
  connection: DriveSyncConnection,
  client: SupabaseClient,
  deps: DriveSyncDependencies = defaultDependencies,
): Promise<void> {
  const { data, error } = await client
    .from("connections")
    .select("id, workspace_id, status, credential_id, cursor_json, connected_by_user_id")
    .eq("id", connection.id)
    .eq("workspace_id", connection.workspace_id)
    .single();
  if (error) throw error;
  const row = data as ConnectionRow;
  const cursor = { ...(row.cursor_json ?? {}) } as DriveCursor;
  const now = deps.now();

  // A reconnect sets the connection back to active, which resumes polling.
  if (cursor.reauth_required && row.status === "degraded") return;
  delete cursor.reauth_required;
  if (!row.credential_id) {
    await markNeedsReconnect(connection, cursor, client, now);
    return;
  }

  const settings = deps.settings();
  if (!settings) throw new Error("Google OAuth is not configured");

  let accessToken: string;
  try {
    const credential = await resolveProviderCredentialById(row.workspace_id, "google_drive", row.credential_id, client);
    accessToken = (await deps.refreshAccessToken(settings, credential.refresh_token)).accessToken;
  } catch (refreshError) {
    const grantGone =
      (refreshError instanceof GoogleOAuthError && refreshError.code === "invalid_grant") ||
      (refreshError instanceof CredentialError && refreshError.reason !== "decrypt_failed");
    if (grantGone) {
      await markNeedsReconnect(connection, cursor, client, now);
      return;
    }
    throw refreshError;
  }

  const api = deps.createApi(accessToken);
  try {
    const folders = await listSyncedGoogleDriveFolders(client, row.workspace_id, row.id);
    const fileCache: DriveFileCache = new Map();
    const ctx: PassContext = {
      connection,
      ownerUserId: row.connected_by_user_id,
      api,
      client,
      deps,
      resolver: createFolderResolver(api, folders, fileCache),
      fileCache,
      handled: new Set(),
      deferred: new Set(cursor.deferred_file_ids ?? []),
      now,
    };

    for (const fileId of [...ctx.deferred].slice(0, MAX_FILES_PER_POLL)) {
      try {
        await handleFile(ctx, { fileId, file: await api.getFile(fileId) });
      } catch (fileError) {
        if (!isDriveError(fileError, "forbidden", "not_found")) throw fileError;
        ctx.deferred.delete(fileId);
        if (isDriveError(fileError, "not_found")) await handleGone(ctx, fileId);
      }
    }

    const next: DriveCursor = {};
    if (cursor.start_page_token) {
      try {
        Object.assign(next, await changesPass(ctx, cursor));
      } catch (changesError) {
        if (!isDriveError(changesError, "invalid_page_token")) throw changesError;
        // The saved position expired: take a new one and backfill every folder again.
        next.start_page_token = await api.getStartPageToken();
        cursor.backfill = undefined;
      }
      next.comment_refresh_after = await refreshRecentComments(ctx, cursor.comment_refresh_after);
    } else {
      next.start_page_token = await api.getStartPageToken();
    }
    const folderRemoved = Object.keys(cursor.backfill?.folders ?? {}).some((id) => !folders.some((folder) => folder.googleFolderId === id));
    if (folderRemoved || cursor.folder_cleanup_after !== undefined) {
      const after = await cleanRemovedFolders(ctx, folderRemoved ? null : cursor.folder_cleanup_after ?? null);
      if (after !== undefined) next.folder_cleanup_after = after;
    }
    next.backfill = await backfillPass(ctx, folders, cursor);
    if (ctx.deferred.size > 0) next.deferred_file_ids = [...ctx.deferred];
    if (!next.change_page_token) delete next.change_page_token;
    if (!next.comment_refresh_after) delete next.comment_refresh_after;

    const { error: updateError } = await client
      .from("connections")
      .update({ status: "active", last_success_at: now.toISOString(), cursor_json: next })
      .eq("id", connection.id)
      .eq("workspace_id", connection.workspace_id)
      .in("status", LIVE_STATUSES);
    if (updateError) throw updateError;
  } catch (syncError) {
    if (isDriveError(syncError, "unauthorized")) {
      await markNeedsReconnect(connection, cursor, client, now);
      return;
    }
    recordRouteError({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      operation: "ingestion",
      errorCode: "drive_sync_failed",
      error: syncError,
    });
    throw syncError;
  }
}
