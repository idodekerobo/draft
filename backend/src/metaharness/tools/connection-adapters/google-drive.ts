import type { SupabaseClient } from "@supabase/supabase-js";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../../config";
import { recordError } from "../../../errors/record-error";
import { driveAccessFor } from "../../../ingestion/google-drive/access";
import { DriveApiError } from "../../../ingestion/google-drive/api";
import { renderDriveFile } from "../../../ingestion/google-drive/render-file";
import { driveVersionKey, writeDriveFile } from "../../../ingestion/google-drive/sync";
import { refuse, type ToolHandlerResult } from "../tool-registry";
import type { ToolCaller } from "draft-core/tools";
import type { BrowseInput, ConnectionAdapter, ReadInput, ScopeInput, SearchInput } from "./types";
import { type DriveFoldersDependencies, listDriveFolders, listDriveFolderOptions, addDriveFolder, removeDriveFolder } from "../../../ingestion/google-drive/folders-service";
import { callerWorkspaceId } from "../definitions/shared";

export interface DriveToolDeps {
  fetch?: typeof fetch;
  driveAccess?: typeof driveAccessFor;
  settings?: () => GoogleOAuthSettings | null;
  now?: () => Date;
}

const FRESH_MS = 5 * 60 * 1000;
const LIVE_FETCHES_PER_MINUTE = 10;
const VERSIONS_PER_PAGE = 50;
const SUMMARY_CHARS = 120;

// Per process: the registry is rebuilt per MCP request, so the cap cannot live on the tool instance.
const liveFetches = new Map<string, number[]>();

export function resetDriveLiveFetchLimit(): void {
  liveFetches.clear();
}

function takeLiveFetch(userId: string, nowMs: number): boolean {
  const recent = (liveFetches.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
  if (recent.length >= LIVE_FETCHES_PER_MINUTE) {
    liveFetches.set(userId, recent);
    return false;
  }
  recent.push(nowMs);
  liveFetches.set(userId, recent);
  return true;
}

const redactCursor = (cursor: string | undefined) => (cursor ? "[redacted]" : undefined);
const invalidCursor = () => refuse("invalid_cursor", "That cursor isn't one this tool returned for this request. Pass nextCursor from the previous page.");

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(value: string, check: (parsed: Record<string, unknown>) => T | null): T | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && parsed.v === 1 ? check(parsed) : null;
  } catch {
    return null;
  }
}

const isOffset = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isoTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Moves `end` back so a UTF-8 slice never splits a character. */
function charBoundary(bytes: Buffer, end: number): number {
  let at = Math.min(end, bytes.length);
  while (at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at--;
  return at;
}

interface DriveConnectionRow {
  id: string;
  connected_by_user_id: string | null;
  status: string;
  last_success_at: string | null;
}

interface DriveVersionRow {
  id: string;
  connection_id: string;
  external_version: string;
  created_at: string;
  normalized_at: string | null;
  lifecycle_status: string;
  content_markdown: string | null;
  metadata_json: Record<string, unknown> | null;
}

// A reverted file revives its old row, so normalized_at (reset on every write) is when the version became current.
const capturedAt = (row: DriveVersionRow) => row.normalized_at ?? row.created_at;
const timeOf = (row: DriveVersionRow) => Date.parse(capturedAt(row));
const latestOf = (versions: DriveVersionRow[]) => versions.find((row) => row.lifecycle_status === "active") ?? versions[versions.length - 1]!;

/** The first line that changed from the previous version, cut to 120 characters. Null for the first version. */
export function changeSummary(previous: string | null, current: string): string | null {
  if (previous === null) return null;
  const before = previous.split("\n");
  const after = current.split("\n");
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] === after[index]) continue;
    const line = (after[index] ?? before[index] ?? "").trim();
    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
  }
  return null;
}

type ReadCursor = { v: 1; kind: "drive_read"; file_id: string; version_id: string; offset: number; versions_offset: number };
type SearchCursor = { v: 1; kind: "drive_search"; key: string; rank: number; id: string };

/** Drive files stored from synced folders. Only shared items; superseded versions are readable here only. */
export function createDriveAdapter(client: SupabaseClient, deps: DriveToolDeps = {}): ConnectionAdapter {
  const settings = deps.settings ?? googleOAuthSettings;
  const now = deps.now ?? (() => new Date());

  async function driveConnections(workspaceId: string): Promise<DriveConnectionRow[]> {
    const { data, error } = await client
      .from("connections")
      .select("id, connected_by_user_id, status, last_success_at")
      .eq("workspace_id", workspaceId)
      .eq("provider", "google_drive");
    if (error) throw error;
    return (data ?? []) as DriveConnectionRow[];
  }

  /** Every stored version of the file, oldest first by when each became current. */
  async function versionsOf(workspaceId: string, fileId: string, connections: DriveConnectionRow[]): Promise<DriveVersionRow[]> {
    if (connections.length === 0) return [];
    const { data, error } = await client
      .from("source_items")
      .select("id, connection_id, external_version, created_at, normalized_at, lifecycle_status, content_markdown, metadata_json")
      .eq("workspace_id", workspaceId)
      .eq("external_id", fileId)
      .eq("visibility", "shared")
      .in("connection_id", connections.map((connection) => connection.id))
      .in("lifecycle_status", ["active", "superseded"]);
    if (error) throw error;
    return ((data ?? []) as DriveVersionRow[]).sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id));
  }

  /** Fetches the file with the asker's own Drive login and stores it under the connection that owns the latest copy. */
  async function refreshLive(workspaceId: string, askerId: string, fileId: string, latest: DriveVersionRow, owner: DriveConnectionRow): Promise<"changed" | "unchanged" | "unavailable"> {
    // A disconnected owner cannot take new versions; the stored copy is all there is.
    if (owner.status !== "active" && owner.status !== "degraded") return "unavailable";
    if (!takeLiveFetch(askerId, now().getTime())) return "unavailable";
    try {
      const access = await driveAccessFor(client, workspaceId, askerId, { settings, fetchImpl: deps.fetch ?? fetch, now });
      if (!access.ok) return "unavailable";
      const file = await access.api.getFile(fileId);
      const rendered = await renderDriveFile(access.api, file);
      if (!rendered) return "unavailable";
      if (driveVersionKey(rendered) === latest.external_version) return "unchanged";
      const folderPath = typeof latest.metadata_json?.folder_path === "string" ? latest.metadata_json.folder_path : null;
      await writeDriveFile(client, { workspaceId, connectionId: owner.id, ownerUserId: owner.connected_by_user_id, file, rendered, folderPath, now: now() });
      return "changed";
    } catch (cause) {
      // A file the asker cannot open is an expected answer; anything else is a failure worth seeing.
      if (!(cause instanceof DriveApiError && (cause.code === "not_found" || cause.code === "forbidden"))) {
        await recordError({ client, workspaceId, connectionId: owner.id, operation: "read", code: "drive_live_fetch_failed", message: "Refreshing a Drive file from Google failed", detail: { file_id: fileId }, error: cause });
      }
      if (cause instanceof DriveApiError) return "unavailable";
      throw cause;
    }
  }

  async function read(caller: ToolCaller, input: ReadInput): Promise<ToolHandlerResult> {
      const workspaceId = callerWorkspaceId(caller);
      if (!input.fileId || input.channel || input.messageId || input.threadId || input.attachmentId) return refuse("invalid_input", "Google Drive read needs fileId, with optional version, asOf, include, maxBytes and cursor.");
      if (input.maxBytes !== undefined && (input.maxBytes < 1024 || input.maxBytes > 262144)) return refuse("invalid_input", "Drive maxBytes must be between 1024 and 262144.");
      const wantsVersion = input.version !== undefined && input.version !== "latest";
      if (wantsVersion && input.asOf !== undefined) return refuse("invalid_input", "Pass version or asOf, not both.");
      const asOf = input.asOf === undefined ? null : isoTime(input.asOf);
      if (input.asOf !== undefined && !asOf) return refuse("invalid_input", "asOf must be an ISO time.");
      const cursor = input.cursor === undefined ? null : decodeCursor<ReadCursor>(input.cursor, (parsed) =>
        parsed.kind === "drive_read" && parsed.file_id === input.fileId && typeof parsed.version_id === "string" && isOffset(parsed.offset) && isOffset(parsed.versions_offset)
          ? (parsed as ReadCursor) : null);
      if (input.cursor !== undefined && !cursor) return invalidCursor();

      const connections = await driveConnections(workspaceId);
      let versions = await versionsOf(workspaceId, input.fileId, connections);
      if (versions.length === 0) return refuse("drive_file_not_found", "No stored Drive file has this file_id. Find files with connections.search with provider google_drive.");

      let source: "stored" | "live" = "stored";
      let stale = false;
      const latestOnly = !cursor && !wantsVersion && !asOf;
      if (latestOnly) {
        const latest = latestOf(versions);
        const owner = connections.find((connection) => connection.id === latest.connection_id)!;
        const checkedAt = owner.last_success_at ? new Date(owner.last_success_at).getTime() : 0;
        if (now().getTime() - checkedAt > FRESH_MS) {
          const outcome = caller.onBehalfOf ? await refreshLive(workspaceId, caller.onBehalfOf, input.fileId, latest, owner) : "unavailable";
          if (outcome === "changed") {
            versions = await versionsOf(workspaceId, input.fileId, connections);
            source = "live";
          } else if (outcome === "unavailable") {
            stale = true;
          }
        }
      }

      let chosen: DriveVersionRow | undefined;
      if (cursor) chosen = versions.find((row) => row.id === cursor.version_id);
      else if (wantsVersion) chosen = versions.find((row) => row.id === input.version);
      else if (asOf) chosen = versions.filter((row) => timeOf(row) <= Date.parse(asOf)).pop();
      else chosen = latestOf(versions);
      if (!chosen) {
        if (cursor) return invalidCursor();
        if (asOf) return refuse("drive_no_version_at_time", `The first stored version of this file is from ${capturedAt(versions[0]!)}.`);
        return refuse("drive_version_not_found", "This file has no stored version with that version_id. List them with include: [\"versions\"].");
      }

      const body = Buffer.from(chosen.content_markdown ?? "", "utf8");
      const offset = cursor?.offset ?? 0;
      if (offset > body.length) return invalidCursor();
      const end = charBoundary(body, offset + (input.maxBytes ?? 32768));
      const truncated = end < body.length;

      const versionsOffset = cursor?.versions_offset ?? 0;
      const withVersions = input.include?.includes("versions") ?? false;
      let versionList: Array<Record<string, unknown>> | undefined;
      let moreVersions = false;
      if (withVersions) {
        const newestFirst = versions.map((row, index) => ({ row, previous: versions[index - 1] ?? null })).reverse();
        versionList = newestFirst.slice(versionsOffset, versionsOffset + VERSIONS_PER_PAGE).map(({ row, previous }) => ({
          versionId: row.id,
          capturedAt: capturedAt(row),
          lastModifiedBy: row.metadata_json?.last_modified_by ?? null,
          changeSummary: changeSummary(previous ? previous.content_markdown ?? "" : null, row.content_markdown ?? ""),
        }));
        moreVersions = versionsOffset + VERSIONS_PER_PAGE < newestFirst.length;
      }
      const next_cursor = truncated || moreVersions
        ? encodeCursor({
          v: 1, kind: "drive_read", file_id: input.fileId, version_id: chosen.id,
          offset: truncated ? end : body.length, versions_offset: moreVersions ? versionsOffset + VERSIONS_PER_PAGE : versions.length,
        } satisfies ReadCursor)
        : null;

      const metadata = chosen.metadata_json ?? {};
      return {
        status: "ok",
        output: {
          provider: "google_drive",
          fileId: input.fileId,
          title: metadata.title ?? null,
          webViewLink: metadata.web_view_link ?? null,
          versionCount: versions.length,
          firstCapturedAt: capturedAt(versions[0]!),
          lastCapturedAt: capturedAt(versions[versions.length - 1]!),
          versionId: chosen.id,
          capturedAt: capturedAt(chosen),
          isLatest: chosen.lifecycle_status === "active",
          source,
          ...(stale ? { stale: true } : {}),
          content: body.subarray(offset, end).toString("utf8"),
          truncated,
          nextCursor: next_cursor,
          ...(versionList ? { versions: versionList } : {}),
        },
      };
  }

  async function search(caller: ToolCaller, input: SearchInput): Promise<ToolHandlerResult> {
      if (!input.query && !input.fileId) return refuse("invalid_input", "Pass query, file_id or both.");
      const after = input.since === undefined ? null : isoTime(input.since);
      const before = input.until === undefined ? null : isoTime(input.until);
      if ((input.since !== undefined && !after) || (input.until !== undefined && !before)) {
        return refuse("invalid_input", "since and until must be ISO times.");
      }
      const key = JSON.stringify([input.query ?? null, input.fileId ?? null, input.includeHistory ?? false, after, before]);
      const cursor = input.cursor === undefined ? null : decodeCursor<SearchCursor>(input.cursor, (parsed) =>
        parsed.kind === "drive_search" && parsed.key === key && typeof parsed.rank === "number" && typeof parsed.id === "string" ? (parsed as SearchCursor) : null);
      if (input.cursor !== undefined && !cursor) return invalidCursor();

      const limit = input.limit ?? 10;
      const { data, error } = await client.rpc("search_drive_items", {
        p_workspace_id: callerWorkspaceId(caller),
        p_query: input.query ?? null,
        p_include_history: input.includeHistory ?? false,
        p_file_id: input.fileId ?? null,
        p_modified_after: after,
        p_modified_before: before,
        p_after_rank: cursor?.rank ?? null,
        p_after_id: cursor?.id ?? null,
        p_limit: limit + 1,
      });
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string; external_id: string; title: string | null; occurred_at: string; created_at: string; lifecycle_status: string; rank: number; snippet: string | null;
      }>;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: "ok",
        output: {
          provider: "google_drive",
          results: page.map((row) => ({
            id: row.external_id,
            fileId: row.external_id,
            date: row.occurred_at,
            versionId: row.id,
            title: row.title,
            snippet: row.snippet,
            modifiedAt: row.occurred_at,
            capturedAt: row.created_at,
            isLatest: row.lifecycle_status === "active",
          })),
          nextCursor: rows.length > limit && last ? encodeCursor({ v: 1, kind: "drive_search", key, rank: last.rank, id: last.id } satisfies SearchCursor) : null,
        },
      };
  }

  const folderDeps: DriveFoldersDependencies = { db: client, driveAccess: deps.driveAccess ?? ((db, workspaceId, userId) => driveAccessFor(db, workspaceId, userId, { settings, fetchImpl: deps.fetch ?? fetch, now })), now };
  async function folderResult(response: Response): Promise<ToolHandlerResult> {
    const body = await response.json() as Record<string, unknown>;
    return response.ok ? { status: "ok", output: { provider: "google_drive", ...body } }
      : refuse(String(body.error ?? "drive_folders_failed"), String(body.message ?? body.error ?? "The Drive folder operation failed."));
  }
  async function changeFolders(caller: ToolCaller, input: ScopeInput, joining: boolean): Promise<ToolHandlerResult> {
    if (!caller.onBehalfOf || caller.origin.kind !== "person") return refuse("person_required", "Only a signed-in person can change synced Drive folders.");
    if (!input.folders?.length || input.channels) return refuse("invalid_input", "Google Drive needs folders: Google folder ids to join, or synced folder ids to leave.");
    const changed: unknown[] = [];
    for (const id of input.folders) {
      const response = joining
        ? await addDriveFolder(caller.workspaceId, caller.onBehalfOf, { googleFolderId: id }, folderDeps)
        : await removeDriveFolder(caller.workspaceId, caller.onBehalfOf, id, folderDeps);
      const result = await folderResult(response);
      if (result.status !== "ok") return result;
      changed.push(result.output);
    }
    return { status: "ok", output: { provider: "google_drive", changed } };
  }
  async function browse(caller: ToolCaller, input: BrowseInput) {
    if (!caller.onBehalfOf) return { ok: false as const, code: "person_required", error: "Drive browsing needs a person's own login." };
    const key = JSON.stringify([caller.workspaceId, caller.onBehalfOf, input.query ?? null]);
    const cursor = input.cursor ? decodeCursor<{ offset: number }>(input.cursor, p => p.kind === "drive_folders" && p.key === key && isOffset(p.offset) ? { offset: p.offset } : null) : { offset: 0 };
    if (!cursor) return { ok: false as const, code: "invalid_cursor", error: "Pass nextCursor from the previous folder page." };
    const options: Record<string, unknown>[] = [];
    for (const parent of ["root", "shared"]) {
      const response = await listDriveFolderOptions(caller.workspaceId, caller.onBehalfOf, parent, folderDeps);
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) return { ok: false as const, code: String(body.error), error: String(body.message ?? body.error) };
      options.push(...body.options as Record<string, unknown>[]);
    }
    const filtered = options.filter(o => !input.query || String(o.name).toLowerCase().includes(input.query.toLowerCase()));
    const end = cursor.offset + input.limit;
    return { ok: true as const, fields: { folders: filtered.slice(cursor.offset, end).map(o => ({ id: o.google_folder_id, name: o.name, folderKind: o.folder_kind, synced: o.synced, syncedByYou: o.synced_by_you, syncedBy: o.synced_by })), nextCursor: end < filtered.length ? encodeCursor({ v: 1, kind: "drive_folders", key, offset: end }) : null } };
  }
  return {
    provider: "google_drive",
    notConnectedMessage: "Connect Google with draft connections connect --provider google.",
    actions: [
      { verb: "search", description: "Search stored Drive files", fields: { query: "Keywords", fileId: "Only this file", includeHistory: "Also search older versions" } },
      { verb: "read", description: "Read a stored Drive file and its versions", fields: { fileId: "Google file id", version: "Stored version id", asOf: "ISO time", include: "[versions]", maxBytes: "Bytes per page", cursor: "Next page" } },
      { verb: "join", description: "Sync Google Drive folders", personOnly: true, fields: { folders: "Google folder or shared drive ids" } },
      { verb: "leave", description: "Stop syncing Google Drive folders", personOnly: true, fields: { folders: "Synced folder ids from connections.list" } },
    ],
    read: ({ caller }, input) => read(caller, input),
    search: ({ caller }, input) => search(caller, input),
    join: ({ caller }, input) => changeFolders(caller, input, true),
    leave: ({ caller }, input) => changeFolders(caller, input, false),
    browse: ({ caller }, input) => browse(caller, input),
    describe: async ({ caller }) => {
      if (!caller.onBehalfOf) return {};
      const response = await listDriveFolders(caller.workspaceId, caller.onBehalfOf, folderDeps);
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) return { foldersError: body.error };
      return { folders: (body.folders as Record<string, unknown>[]).map(f => ({ id: f.id, name: f.name, folderKind: f.folder_kind, googleFolderId: f.google_folder_id })), lastSuccessAt: body.last_success_at, reauthRequired: body.reauth_required };
    },
    audit: (_verb, input) => ({ provider: "google_drive", ...input, cursor: redactCursor(input.cursor as string | undefined) }),
  };
}
