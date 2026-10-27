import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { withoutAuthorPrefix } from "../ingestion/claude-code/live-input-text";
import { parseLiveLine, type LiveLineInput, type ParsedLiveEvent } from "../ingestion/claude-code/parse-live-line";
import type { SessionEventRow, SessionRow } from "../types/tables";
import { loadDisplayNames } from "./session-display-names";
import { failQueuedInputs, matchConsumedInputs } from "./sessions-live-inputs";
import { SESSION_COLUMNS, authorize, errorResponse, knownDbError, loadOwnedSession, optionalString, readBody } from "./sessions-live-shared";

type WorkspaceRequest = Bun.BunRequest<"/workspaces/:id/live-sessions">;
type SessionRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId">;
type EventsRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/events">;
type LinesRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/lines">;
type EndRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/end">;
type RawRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/raw">;
type RawCompleteRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/raw/complete">;

const MAX_LINES_PER_POST = 2000;
const DEFAULT_EVENTS_PAGE = 500;
const MAX_EVENTS_PAGE = 1000;
const LIST_LIMIT = 50;
const TITLE_MAX_CHARS = 120;
const RAW_BUCKET = "session-raw";
const RAW_FILE = /^(root|subagents\/agent-[A-Za-z0-9_-]+)\.jsonl$/;

async function withOwnerNames(workspaceId: string, sessions: SessionRow[]) {
  const names = await loadDisplayNames(serviceClient, [...new Set(sessions.map((s) => s.owner_user_id))], []);
  if (!names.ok) return errorResponse(names.code, 500, names.detail, workspaceId);
  return sessions.map((s) => ({ ...s, owner_name: names.users.get(s.owner_user_id) ?? null }));
}

export const LIST = withAuth<WorkspaceRequest>(async (req, caller) => {
  const denied = await authorize(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("workspace_id", req.params.id)
    .eq("session_type", "interactive")
    .order("started_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return errorResponse("sessions_lookup_failed", 500, error, req.params.id);

  const sessions = await withOwnerNames(req.params.id, (data ?? []) as SessionRow[]);
  if (sessions instanceof Response) return sessions;
  return Response.json({ sessions });
});

export const CREATE = withAuth<WorkspaceRequest>(async (req, caller) => {
  const denied = await authorize(req.params.id, caller.userId);
  if (denied) return denied;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  const hostMachineId = optionalString(body.hostMachineId, 200);
  if (!hostMachineId) return errorResponse("missing_host_machine_id", 400);

  const { data, error } = await serviceClient
    .from("sessions")
    .insert({
      workspace_id: req.params.id,
      owner_user_id: caller.userId,
      host_machine_id: hostMachineId,
      host_name: optionalString(body.hostName, 200),
      folder_name: optionalString(body.folderName, 200),
      git_remote: optionalString(body.gitRemote, 500),
      model: optionalString(body.model, 100),
      native_session_id: optionalString(body.nativeSessionId, 200),
    })
    .select(SESSION_COLUMNS)
    .single<SessionRow>();
  if (error || !data) return errorResponse("session_create_failed", 500, error, req.params.id);

  return Response.json({ ok: true, session: data }, { status: 201 });
});

export const EVENTS = withAuth<EventsRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const after = Math.max(0, Number(params.get("after")) || 0);
  const limit = Math.min(MAX_EVENTS_PAGE, Math.max(1, Number(params.get("limit")) || DEFAULT_EVENTS_PAGE));

  const { data: session, error: sessionError } = await serviceClient
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<SessionRow>();
  if (sessionError) return errorResponse("session_lookup_failed", 500, sessionError, workspaceId, sessionId);
  if (!session) return errorResponse("session_not_found", 404);

  const { data: events, error: eventsError } = await serviceClient
    .from("session_events")
    .select("seq, source_id, kind, payload, created_at")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .gt("seq", after)
    .order("seq", { ascending: true })
    .limit(limit);
  if (eventsError) return errorResponse("events_lookup_failed", 500, eventsError, workspaceId, sessionId);

  const named = await withOwnerNames(workspaceId, [session]);
  if (named instanceof Response) return named;
  return Response.json({ session: named[0], events: (events ?? []) as Partial<SessionEventRow>[] });
});

type IncomingLine = LiveLineInput | { file: string; offset: number; oversizeBytes: number };

function isIncomingLine(value: unknown): value is IncomingLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (typeof line.file !== "string" || !Number.isInteger(line.offset)) return false;
  return typeof line.raw === "string" || Number.isInteger(line.oversizeBytes);
}

function eventsFor(line: IncomingLine): ParsedLiveEvent[] {
  if ("raw" in line) return parseLiveLine(line);
  return [
    {
      sourceId: `${line.file}:${line.offset}`,
      kind: "session_note",
      payload: { text: "A very large item was skipped", reason: "too_large", bytes: line.oversizeBytes },
    },
  ];
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim().slice(0, TITLE_MAX_CHARS) ?? "";
}

export const LINES = withAuth<LinesRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  const hostMachineId = optionalString(body.hostMachineId, 200);
  if (!hostMachineId) return errorResponse("missing_host_machine_id", 400);
  if (!Array.isArray(body.lines) || body.lines.length > MAX_LINES_PER_POST || !body.lines.every(isIncomingLine)) {
    return errorResponse("invalid_lines", 400);
  }

  const incoming = body.lines as IncomingLine[];
  for (const line of incoming) {
    if ("oversizeBytes" in line) {
      void recordError({
        workspaceId,
        sessionId,
        operation: "session",
        message: "Session line too large to forward",
        code: "line_too_large",
        detail: { file: line.file, offset: line.offset, bytes: line.oversizeBytes },
      });
    }
  }
  const events = incoming
    .flatMap(eventsFor)
    .map((event) => ({ source_id: event.sourceId, kind: event.kind, payload: event.payload }));

  let lastSeq = owned.session.last_seq;
  let inserted = 0;
  if (events.length > 0) {
    const { data, error } = await serviceClient.rpc("append_session_events", {
      p_session_id: sessionId,
      p_workspace_id: workspaceId,
      p_host_machine_id: hostMachineId,
      p_events: events,
    });
    if (error) {
      return knownDbError(error.message) ?? errorResponse("append_failed", 500, error, workspaceId, sessionId);
    }
    ({ last_seq: lastSeq, inserted } = data as { last_seq: number; inserted: number });
    if (inserted > 0) await matchConsumedInputs(workspaceId, sessionId, owned.session.last_seq, lastSeq);
  } else if (owned.session.host_machine_id !== hostMachineId) {
    return errorResponse("foreign_host", 403);
  }

  const firstPrompt = events.find((e) => e.kind === "user_message" && !(e.payload as { agent_id?: string }).agent_id);
  const nativeSessionId = optionalString(body.nativeSessionId, 200);
  if (owned.session.title === null && firstPrompt) {
    const title = firstLine(withoutAuthorPrefix((firstPrompt.payload as { text: string }).text));
    if (title) await serviceClient.from("sessions").update({ title }).eq("id", sessionId).is("title", null);
  }
  if (owned.session.native_session_id === null && nativeSessionId) {
    await serviceClient.from("sessions").update({ native_session_id: nativeSessionId }).eq("id", sessionId).is("native_session_id", null);
  }

  return Response.json({ ok: true, last_seq: lastSeq, inserted });
});

export const END = withAuth<EndRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const hostMachineId = optionalString(parsed.body.hostMachineId, 200);
  if (hostMachineId !== owned.session.host_machine_id) return errorResponse("foreign_host", 403);

  const { error } = await serviceClient
    .from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: optionalString(parsed.body.reason, 100) ?? "ended", open_approval_count: 0 })
    .eq("id", sessionId)
    .neq("status", "ended");
  if (error) return errorResponse("session_end_failed", 500, error, workspaceId, sessionId);
  await failQueuedInputs(sessionId);

  return Response.json({ ok: true });
});

export const RAW_UPLOAD_URLS = withAuth<RawRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  if (optionalString(parsed.body.hostMachineId, 200) !== owned.session.host_machine_id) return errorResponse("foreign_host", 403);

  const files = parsed.body.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 200 || !files.every((f) => typeof f === "string" && RAW_FILE.test(f))) {
    return errorResponse("invalid_files", 400);
  }

  const uploads = [];
  for (const file of files as string[]) {
    const objectPath = `${workspaceId}/${sessionId}/${file}.gz`;
    const { data, error } = await serviceClient.storage.from(RAW_BUCKET).createSignedUploadUrl(objectPath, { upsert: true });
    if (error || !data) return errorResponse("upload_url_failed", 500, error, workspaceId, sessionId);
    uploads.push({ file, signedUrl: data.signedUrl });
  }
  return Response.json({ ok: true, uploads });
});

export const RAW_UPLOAD_COMPLETE = withAuth<RawCompleteRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  if (optionalString(parsed.body.hostMachineId, 200) !== owned.session.host_machine_id) return errorResponse("foreign_host", 403);

  const prefix = `${workspaceId}/${sessionId}`;
  const { data: objects, error: listError } = await serviceClient.storage.from(RAW_BUCKET).list(prefix);
  if (listError) return errorResponse("raw_list_failed", 500, listError, workspaceId, sessionId);
  if (!objects?.some((o) => o.name === "root.jsonl.gz")) return errorResponse("raw_not_uploaded", 409);

  const { error } = await serviceClient
    .from("sessions")
    .update({ raw_storage_path: `${prefix}/`, raw_uploaded_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) return errorResponse("raw_record_failed", 500, error, workspaceId, sessionId);

  return Response.json({ ok: true });
});
