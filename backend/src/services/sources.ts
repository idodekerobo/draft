import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SOURCE_FULL_SUMMARY_MAX_BYTES,
  SOURCE_QUERY_MAX_CHARACTERS,
  SOURCE_RESPONSE_DEFAULT_MAX_BYTES,
  SOURCE_RESPONSE_MAX_MAX_BYTES,
  SOURCE_RESPONSE_MIN_MAX_BYTES,
  SOURCE_SEARCH_DEFAULT_LIMIT,
  SOURCE_SEARCH_MAX_LIMIT,
  SOURCE_REPRESENTATIONS,
  type SourceAttribution,
  type SourceDescriptor,
  type SourceDomainError,
  type SourceReadInput,
  type SourceReadResponse,
  type SourceRepresentation,
  type SourceRepresentationKind,
  type SourceSearchInput,
  type SourceSearchResponse,
  type SourceTimeBasis,
} from "draft-core/sources";

type SourceResult<T> = { ok: true; value: T } | ({ ok: false } & SourceDomainError);

interface SearchRow {
  source_item_id: string;
  source_version: string;
  title: string | null;
  provider: string;
  item_type: string;
  representation_kind: SourceRepresentationKind;
  occurred_at: string;
  source_time_start: string | null;
  source_time_end: string | null;
  metadata_json: Record<string, unknown>;
  content_markdown: string;
  sanitized_raw_json: unknown;
  agent_session_id: string | null;
  excerpt: string;
  rank: number;
}

interface SearchCursor {
  v: 1;
  kind: "search";
  binding: string;
  rank: number;
  occurred_at: string;
  id: string;
}

interface ReadCursor {
  v: 1;
  kind: "read";
  source_item_id: string;
  representation: SourceRepresentation;
  representation_version: string;
  offset: number;
}

const ITEM_TYPES = new Set([
  "meeting_transcript", "meeting_notes", "message", "coding_session", "document", "provider_event",
]);

function failure(code: SourceDomainError["error"]["code"], message: string): SourceResult<never> {
  return { ok: false, error: { code, message } };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function encodeCursor(value: SearchCursor | ReadCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseSearchCursor(value: string, binding: string): SourceResult<SearchCursor> {
  try {
    const parsed = decodeCursor(value);
    if (!parsed || typeof parsed !== "object") return failure("invalid_cursor", "Invalid search cursor.");
    const cursor = parsed as Record<string, unknown>;
    if (!hasExactKeys(cursor, ["v", "kind", "binding", "rank", "occurred_at", "id"]) ||
        cursor.v !== 1 || cursor.kind !== "search" || typeof cursor.binding !== "string" ||
        typeof cursor.rank !== "number" || !Number.isFinite(cursor.rank) ||
        typeof cursor.occurred_at !== "string" || Number.isNaN(Date.parse(cursor.occurred_at)) ||
        typeof cursor.id !== "string") {
      return failure("invalid_cursor", "Invalid search cursor.");
    }
    if (cursor.binding !== binding) return failure("cursor_mismatch", "Cursor does not match the search arguments.");
    return { ok: true, value: cursor as unknown as SearchCursor };
  } catch {
    return failure("invalid_cursor", "Invalid search cursor.");
  }
}

function parseReadCursor(value: string, sourceItemId: string, representation: SourceRepresentation): SourceResult<ReadCursor> {
  try {
    const parsed = decodeCursor(value);
    if (!parsed || typeof parsed !== "object") return failure("invalid_cursor", "Invalid read cursor.");
    const cursor = parsed as Record<string, unknown>;
    if (!hasExactKeys(cursor, ["v", "kind", "source_item_id", "representation", "representation_version", "offset"]) ||
        cursor.v !== 1 || cursor.kind !== "read" || cursor.source_item_id !== sourceItemId ||
        cursor.representation !== representation || typeof cursor.representation_version !== "string" ||
        typeof cursor.offset !== "number" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
      return failure("invalid_cursor", "Invalid read cursor.");
    }
    return { ok: true, value: cursor as unknown as ReadCursor };
  } catch {
    return failure("invalid_cursor", "Invalid read cursor.");
  }
}

function parseMaxBytes(value: number | undefined): SourceResult<number> {
  const maxBytes = value ?? SOURCE_RESPONSE_DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < SOURCE_RESPONSE_MIN_MAX_BYTES || maxBytes > SOURCE_RESPONSE_MAX_MAX_BYTES) {
    return failure("invalid_max_bytes", `max_bytes must be between ${SOURCE_RESPONSE_MIN_MAX_BYTES} and ${SOURCE_RESPONSE_MAX_MAX_BYTES}.`);
  }
  return { ok: true, value: maxBytes };
}

function normalizeDate(value: string | undefined, endExclusive: boolean): SourceResult<string | null> {
  if (!value) return { ok: true, value: null };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = dateOnly ? `${value}T00:00:00.000Z` : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return failure("invalid_filter", `Invalid ${endExclusive ? "until" : "since"} value.`);
  return { ok: true, value: date.toISOString() };
}

function searchBinding(input: { query: string; provider: string | null; type: string[]; since: string | null; until: string | null }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("base64url");
}

function attribution(metadata: Record<string, unknown>): SourceAttribution[] {
  const result: SourceAttribution[] = [];
  if (typeof metadata.author === "string") result.push({ name: metadata.author, role: "author", provider_user_id: null });
  const attendees = Array.isArray(metadata.attendees) ? metadata.attendees : [];
  for (const attendee of attendees) {
    if (typeof attendee === "string") result.push({ name: attendee, role: "participant", provider_user_id: null });
  }
  return result;
}

function sourceUrl(metadata: Record<string, unknown>): string | null {
  for (const key of ["source_url", "github_url", "linear_url", "url"]) {
    if (typeof metadata[key] === "string") return metadata[key] as string;
  }
  return null;
}

function availableRepresentations(row: SearchRow): SourceRepresentation[] {
  const values: SourceRepresentation[] = [];
  if (row.content_markdown !== null) values.push("default");
  if (row.sanitized_raw_json !== null) values.push("structured");
  if (row.item_type === "meeting_transcript" || row.item_type === "meeting_notes" || row.item_type === "coding_session") {
    if (row.sanitized_raw_json !== null || row.agent_session_id !== null) values.push("transcript");
  }
  if (row.item_type === "message") values.push("messages");
  return SOURCE_REPRESENTATIONS.filter((representation) => values.includes(representation));
}

function descriptor(row: SearchRow): SourceDescriptor {
  const basis = row.metadata_json.time_basis;
  const timeBasis: SourceTimeBasis = basis === "source_event" || basis === "source_created" ||
    basis === "ingestion_fallback" ? basis : "unknown";
  return {
    source_item_id: row.source_item_id,
    source_version: row.source_version,
    title: row.title,
    provider: row.provider,
    item_type: row.item_type,
    representation_kind: row.representation_kind,
    occurred_at: row.occurred_at,
    source_time_start: row.source_time_start,
    source_time_end: row.source_time_end,
    time_basis: timeBasis,
    attribution: attribution(row.metadata_json),
    source_url: sourceUrl(row.metadata_json),
    available_representations: availableRepresentations(row),
    metadata_truncated: false,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export async function searchSources(
  client: SupabaseClient,
  workspaceId: string,
  callerUserId: string,
  input: SourceSearchInput,
): Promise<SourceResult<SourceSearchResponse>> {
  const query = input.query?.trim();
  if (!query || query.length > SOURCE_QUERY_MAX_CHARACTERS) {
    return failure("invalid_query", `query must contain 1 to ${SOURCE_QUERY_MAX_CHARACTERS} characters.`);
  }
  const limit = input.limit ?? SOURCE_SEARCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_SEARCH_MAX_LIMIT) {
    return failure("invalid_limit", `limit must be between 1 and ${SOURCE_SEARCH_MAX_LIMIT}.`);
  }
  const maxBytesResult = parseMaxBytes(input.max_bytes);
  if (!maxBytesResult.ok) return maxBytesResult;
  const sinceResult = normalizeDate(input.since, false);
  if (!sinceResult.ok) return sinceResult;
  const untilResult = normalizeDate(input.until, true);
  if (!untilResult.ok) return untilResult;
  if (sinceResult.value && untilResult.value && sinceResult.value >= untilResult.value) {
    return failure("invalid_filter", "since must be earlier than until.");
  }
  const types = [...new Set(input.type ?? [])].sort();
  if (types.some((type) => !ITEM_TYPES.has(type))) return failure("invalid_filter", "Unknown source type.");

  const filters = { provider: input.provider ?? null, type: types, since: sinceResult.value, until: untilResult.value };
  const binding = searchBinding({ query, ...filters });
  const cursorResult = input.cursor ? parseSearchCursor(input.cursor, binding) : { ok: true as const, value: null };
  if (!cursorResult.ok) return cursorResult;

  const { data, error } = await client.rpc("search_sources", {
    p_workspace_id: workspaceId,
    p_caller_user_id: callerUserId,
    p_query: query,
    p_provider: filters.provider,
    p_types: types.length ? types : null,
    p_since: filters.since,
    p_until: filters.until,
    p_after_rank: cursorResult.value?.rank ?? null,
    p_after_occurred_at: cursorResult.value?.occurred_at ?? null,
    p_after_id: cursorResult.value?.id ?? null,
    p_limit: limit + 1,
  });
  if (error) return failure("search_failed", "Source search failed.");

  const candidates = (data ?? []) as SearchRow[];
  const results: SourceSearchResponse["results"] = [];
  let lastRow: SearchRow | null = null;
  for (const row of candidates.slice(0, limit)) {
    const fullSummary = row.representation_kind === "summary" && byteLength(row.content_markdown) <= SOURCE_FULL_SUMMARY_MAX_BYTES;
    let content = fullSummary ? row.content_markdown : row.excerpt;
    const result = { ...descriptor(row), content_kind: fullSummary ? "full_summary" as const : "excerpt" as const, content };
    const tentative = { results: [...results, result], next_cursor: null, consistency: "live" as const, filters };
    if (byteLength(JSON.stringify(tentative)) > maxBytesResult.value) {
      const overhead = byteLength(JSON.stringify({ ...result, content: "" })) + byteLength(JSON.stringify({ results, next_cursor: null, consistency: "live", filters })) + 32;
      const allowance = maxBytesResult.value - overhead;
      if (allowance <= 0 && results.length > 0) break;
      content = truncateUtf8(content, Math.max(0, allowance));
      result.content = content;
    }
    results.push(result);
    lastRow = row;
  }

  const hasMore = candidates.length > results.length;
  const nextCursor = hasMore && lastRow ? encodeCursor({
    v: 1, kind: "search", binding, rank: lastRow.rank,
    occurred_at: lastRow.occurred_at, id: lastRow.source_item_id,
  }) : null;
  const response: SourceSearchResponse = { results, next_cursor: nextCursor, consistency: "live", filters };
  if (byteLength(JSON.stringify(response)) > maxBytesResult.value) {
    return failure("response_budget_too_small", "max_bytes is too small for source metadata.");
  }
  return { ok: true, value: response };
}

function meetingTranscript(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const object = raw as Record<string, unknown>;
  const entries = Array.isArray(object.sentences) ? object.sentences : Array.isArray(object.transcript) ? object.transcript : null;
  if (!entries) return null;
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const item = entry as Record<string, unknown>;
    const speaker = typeof item.speakerName === "string" ? item.speakerName : typeof item.speaker === "string" ? item.speaker : null;
    const text = typeof item.text === "string" ? item.text : "";
    return speaker ? `${speaker}: ${text}` : text;
  }).filter(Boolean).join("\n");
}

function sliceUtf8(value: string, offset: number, maxBytes: number): { content: string; nextOffset: number; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (offset > bytes.length) return { content: "", nextOffset: bytes.length, truncated: false };
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { content: bytes.subarray(offset, end).toString("utf8"), nextOffset: end, truncated: end < bytes.length };
}

export async function readSource(
  client: SupabaseClient,
  workspaceId: string,
  callerUserId: string,
  input: SourceReadInput,
): Promise<SourceResult<SourceReadResponse>> {
  const representation = input.representation ?? "default";
  if (!SOURCE_REPRESENTATIONS.includes(representation)) return failure("invalid_filter", "Unknown representation.");
  const maxBytesResult = parseMaxBytes(input.max_bytes);
  if (!maxBytesResult.ok) return maxBytesResult;

  const { data, error } = await client.from("source_items")
    .select("id, external_version, source_connection_id, item_type, representation_kind, occurred_at, source_time_start, source_time_end, metadata_json, content_markdown, sanitized_raw_json, agent_session_id, lifecycle_status, visibility, owner_user_id, source_connections(provider)")
    .eq("workspace_id", workspaceId).eq("id", input.source_item_id)
    .or(`visibility.eq.shared,owner_user_id.eq.${callerUserId}`).maybeSingle();
  if (error) return failure("read_failed", "Source read failed.");
  if (!data) return failure("source_not_found", "Source not found.");
  const item = data as Record<string, unknown>;
  if (item.lifecycle_status !== "active") {
    return failure(item.lifecycle_status === "superseded" ? "source_superseded" : "source_not_found", "Source is not active.");
  }
  const connection = item.source_connections as { provider: string } | { provider: string }[] | null;
  const provider = Array.isArray(connection) ? connection[0]?.provider : connection?.provider;
  if (!provider) return failure("read_failed", "Source provider lookup failed.");

  const row: SearchRow = {
    source_item_id: item.id as string, source_version: item.external_version as string,
    title: typeof (item.metadata_json as Record<string, unknown>).title === "string" ? (item.metadata_json as Record<string, unknown>).title as string : null,
    provider, item_type: item.item_type as string,
    representation_kind: item.representation_kind as SourceRepresentationKind, occurred_at: item.occurred_at as string,
    source_time_start: item.source_time_start as string | null, source_time_end: item.source_time_end as string | null,
    metadata_json: item.metadata_json as Record<string, unknown>, content_markdown: item.content_markdown as string,
    sanitized_raw_json: item.sanitized_raw_json, agent_session_id: item.agent_session_id as string | null,
    excerpt: "", rank: 0,
  };

  let format: SourceReadResponse["format"] = "text";
  let content: string | null = null;
  let representationVersion = row.source_version;
  if (representation === "default") {
    format = "markdown";
    content = row.content_markdown;
  } else if (representation === "structured") {
    format = "json";
    content = row.sanitized_raw_json === null ? null : JSON.stringify(row.sanitized_raw_json);
  } else if (representation === "messages") {
    if (row.item_type === "message") {
      const { data: messages, error: messagesError } = await client.from("slack_messages")
        .select("message_ts, user_name_snapshot, text, thread_ts, subtype")
        .eq("workspace_id", workspaceId).eq("source_item_id", row.source_item_id)
        .order("message_ts", { ascending: true });
      if (messagesError) return failure("read_failed", "Slack message read failed.");
      format = "json";
      content = JSON.stringify(messages ?? []);
    }
  } else if (row.agent_session_id) {
    const { data: session, error: sessionError } = await client.from("agent_sessions")
      .select("transcript_revision").eq("workspace_id", workspaceId).eq("id", row.agent_session_id).single();
    if (sessionError) return failure("read_failed", "Coding transcript read failed.");
    representationVersion = `${row.source_version}:transcript:${(session as { transcript_revision: number }).transcript_revision}`;
    const { data: messages, error: messagesError } = await client.from("agent_messages")
      .select("seq, role, content").eq("workspace_id", workspaceId).eq("session_id", row.agent_session_id)
      .order("seq", { ascending: true });
    if (messagesError) return failure("read_failed", "Coding transcript read failed.");
    content = ((messages ?? []) as Array<{ role: string; content: string }>).map((message) => `${message.role}: ${message.content}`).join("\n\n");
  } else {
    content = meetingTranscript(row.sanitized_raw_json);
  }

  if (content === null) return failure("representation_unavailable", `The ${representation} representation is unavailable.`);
  const cursorResult = input.cursor ? parseReadCursor(input.cursor, row.source_item_id, representation) : { ok: true as const, value: null };
  if (!cursorResult.ok) return cursorResult;
  if (cursorResult.value && cursorResult.value.representation_version !== representationVersion) {
    return failure("source_changed", "The source representation changed between pages.");
  }
  const offset = cursorResult.value?.offset ?? 0;
  const source = descriptor(row);
  const overhead = byteLength(JSON.stringify({ source, representation, representation_version: representationVersion, format, content: "", content_offset_bytes: offset, truncated: true, next_cursor: "x".repeat(256) }));
  const page = sliceUtf8(content, offset, Math.max(0, maxBytesResult.value - overhead));
  const nextCursor = page.truncated ? encodeCursor({
    v: 1, kind: "read", source_item_id: row.source_item_id, representation,
    representation_version: representationVersion, offset: page.nextOffset,
  }) : null;
  const response: SourceReadResponse = {
    source, representation, representation_version: representationVersion, format,
    content: page.content, content_offset_bytes: offset, truncated: page.truncated, next_cursor: nextCursor,
  };
  if (byteLength(JSON.stringify(response)) > maxBytesResult.value) {
    return failure("response_budget_too_small", "max_bytes is too small for source metadata.");
  }
  return { ok: true, value: response };
}
