import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../../config";
import { driveAccessFor } from "../../../ingestion/google-drive/access";
import { DriveApiError } from "../../../ingestion/google-drive/api";
import { renderDriveFile } from "../../../ingestion/google-drive/render-file";
import { driveVersionKey, writeDriveFile } from "../../../ingestion/google-drive/sync";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId } from "./shared";

export interface DriveToolDeps {
  fetch?: typeof fetch;
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
const invalidCursor = () => refuse("invalid_cursor", "That cursor isn't one this tool returned for this request. Pass next_cursor from the previous page.");

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
export function createDriveTools(client: SupabaseClient, deps: DriveToolDeps = {}) {
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
    const access = await driveAccessFor(client, workspaceId, askerId, { settings, fetchImpl: deps.fetch ?? fetch, now });
    if (!access.ok) return "unavailable";
    try {
      const file = await access.api.getFile(fileId);
      const rendered = await renderDriveFile(access.api, file);
      if (!rendered) return "unavailable";
      if (driveVersionKey(rendered) === latest.external_version) return "unchanged";
      const folderPath = typeof latest.metadata_json?.folder_path === "string" ? latest.metadata_json.folder_path : null;
      await writeDriveFile(client, { workspaceId, connectionId: owner.id, ownerUserId: owner.connected_by_user_id, file, rendered, folderPath, now: now() });
      return "changed";
    } catch (cause) {
      if (cause instanceof DriveApiError) return "unavailable";
      throw cause;
    }
  }

  const read = defineTool({
    name: "drive.read", mcp: true, requiresWorkspaceConnection: "google_drive",
    description:
      "Read a Google Drive file stored from a synced folder, by file_id. Default is the latest version; pass version (a version_id) or as_of (ISO time) for an older one, not both. " +
      "The latest version is refreshed from Drive when the stored copy is over 5 minutes old. include: [\"versions\"] lists every stored version with what changed. " +
      "Content is cut to max_bytes; when truncated, pass next_cursor back as cursor with the same file_id.",
    input: z.object({
      file_id: z.string().min(1).max(200),
      version: z.string().min(1).max(100).optional().describe("A version_id, or \"latest\" (the default)."),
      as_of: z.string().optional().describe("ISO time. Returns the version stored at that time."),
      include: z.array(z.enum(["versions"])).optional(),
      max_bytes: z.number().int().min(1024).max(262144).optional(),
      cursor: z.string().max(1000).optional(),
    }),
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }): Promise<ToolHandlerResult> => {
      const workspaceId = callerWorkspaceId(caller);
      const wantsVersion = input.version !== undefined && input.version !== "latest";
      if (wantsVersion && input.as_of !== undefined) return refuse("invalid_input", "Pass version or as_of, not both.");
      const asOf = input.as_of === undefined ? null : isoTime(input.as_of);
      if (input.as_of !== undefined && !asOf) return refuse("invalid_input", "as_of must be an ISO time.");
      const cursor = input.cursor === undefined ? null : decodeCursor<ReadCursor>(input.cursor, (parsed) =>
        parsed.kind === "drive_read" && parsed.file_id === input.file_id && typeof parsed.version_id === "string" && isOffset(parsed.offset) && isOffset(parsed.versions_offset)
          ? (parsed as ReadCursor) : null);
      if (input.cursor !== undefined && !cursor) return invalidCursor();

      const connections = await driveConnections(workspaceId);
      let versions = await versionsOf(workspaceId, input.file_id, connections);
      if (versions.length === 0) return refuse("drive_file_not_found", "No stored Drive file has this file_id. Find files with drive.search.");

      let source: "stored" | "live" = "stored";
      let stale = false;
      const latestOnly = !cursor && !wantsVersion && !asOf;
      if (latestOnly) {
        const latest = latestOf(versions);
        const owner = connections.find((connection) => connection.id === latest.connection_id)!;
        const checkedAt = owner.last_success_at ? new Date(owner.last_success_at).getTime() : 0;
        if (now().getTime() - checkedAt > FRESH_MS) {
          const outcome = caller.onBehalfOf ? await refreshLive(workspaceId, caller.onBehalfOf, input.file_id, latest, owner) : "unavailable";
          if (outcome === "changed") {
            versions = await versionsOf(workspaceId, input.file_id, connections);
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
      const end = charBoundary(body, offset + (input.max_bytes ?? 32768));
      const truncated = end < body.length;

      const versionsOffset = cursor?.versions_offset ?? 0;
      const withVersions = input.include?.includes("versions") ?? false;
      let versionList: Array<Record<string, unknown>> | undefined;
      let moreVersions = false;
      if (withVersions) {
        const newestFirst = versions.map((row, index) => ({ row, previous: versions[index - 1] ?? null })).reverse();
        versionList = newestFirst.slice(versionsOffset, versionsOffset + VERSIONS_PER_PAGE).map(({ row, previous }) => ({
          version_id: row.id,
          captured_at: capturedAt(row),
          last_modified_by: row.metadata_json?.last_modified_by ?? null,
          change_summary: changeSummary(previous ? previous.content_markdown ?? "" : null, row.content_markdown ?? ""),
        }));
        moreVersions = versionsOffset + VERSIONS_PER_PAGE < newestFirst.length;
      }
      const next_cursor = truncated || moreVersions
        ? encodeCursor({
          v: 1, kind: "drive_read", file_id: input.file_id, version_id: chosen.id,
          offset: truncated ? end : body.length, versions_offset: moreVersions ? versionsOffset + VERSIONS_PER_PAGE : versions.length,
        } satisfies ReadCursor)
        : null;

      const metadata = chosen.metadata_json ?? {};
      return {
        status: "ok",
        output: {
          file_id: input.file_id,
          title: metadata.title ?? null,
          web_view_link: metadata.web_view_link ?? null,
          version_count: versions.length,
          first_captured_at: capturedAt(versions[0]!),
          last_captured_at: capturedAt(versions[versions.length - 1]!),
          version_id: chosen.id,
          captured_at: capturedAt(chosen),
          is_latest: chosen.lifecycle_status === "active",
          source,
          ...(stale ? { stale: true } : {}),
          content: body.subarray(offset, end).toString("utf8"),
          truncated,
          next_cursor,
          ...(versionList ? { versions: versionList } : {}),
        },
      };
    },
  });

  const search = defineTool({
    name: "drive.search", mcp: true, requiresWorkspaceConnection: "google_drive",
    description:
      "Search Google Drive files stored from synced folders, by keywords. Searches the latest version of each file; include_history: true also searches older versions. " +
      "Each hit names its version_id, captured_at and whether it is the latest. Read a hit with drive.read (file_id, and version for an older one).",
    input: z.object({
      query: z.string().min(1).max(512).optional().describe("Keywords. Optional when file_id is set."),
      file_id: z.string().min(1).max(200).optional(),
      include_history: z.boolean().optional(),
      modified_after: z.string().optional().describe("ISO time."),
      modified_before: z.string().optional().describe("ISO time."),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().max(1000).optional(),
    }),
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }): Promise<ToolHandlerResult> => {
      if (!input.query && !input.file_id) return refuse("invalid_input", "Pass query, file_id or both.");
      const after = input.modified_after === undefined ? null : isoTime(input.modified_after);
      const before = input.modified_before === undefined ? null : isoTime(input.modified_before);
      if ((input.modified_after !== undefined && !after) || (input.modified_before !== undefined && !before)) {
        return refuse("invalid_input", "modified_after and modified_before must be ISO times.");
      }
      const key = JSON.stringify([input.query ?? null, input.file_id ?? null, input.include_history ?? false, after, before]);
      const cursor = input.cursor === undefined ? null : decodeCursor<SearchCursor>(input.cursor, (parsed) =>
        parsed.kind === "drive_search" && parsed.key === key && typeof parsed.rank === "number" && typeof parsed.id === "string" ? (parsed as SearchCursor) : null);
      if (input.cursor !== undefined && !cursor) return invalidCursor();

      const limit = input.limit ?? 10;
      const { data, error } = await client.rpc("search_drive_items", {
        p_workspace_id: callerWorkspaceId(caller),
        p_query: input.query ?? null,
        p_include_history: input.include_history ?? false,
        p_file_id: input.file_id ?? null,
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
          results: page.map((row) => ({
            file_id: row.external_id,
            version_id: row.id,
            title: row.title,
            snippet: row.snippet,
            modified_at: row.occurred_at,
            captured_at: row.created_at,
            is_latest: row.lifecycle_status === "active",
          })),
          next_cursor: rows.length > limit && last ? encodeCursor({ v: 1, kind: "drive_search", key, rank: last.rank, id: last.id } satisfies SearchCursor) : null,
        },
      };
    },
  });

  return [read, search];
}
