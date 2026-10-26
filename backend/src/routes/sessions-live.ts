import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { parseLiveLine, type LiveLineInput } from "../ingestion/claude-code/parse-live-line";
import type { SessionEventRow, SessionRow, WorkspaceRow } from "../types/tables";
import { loadDisplayNames } from "./session-display-names";

type WorkspaceRequest = Bun.BunRequest<"/workspaces/:id/live-sessions">;
type SessionRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId">;
type EventsRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/events">;
type LinesRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/lines">;
type EndRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/end">;

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_LINES_PER_POST = 2000;
const DEFAULT_EVENTS_PAGE = 500;
const MAX_EVENTS_PAGE = 1000;
const LIST_LIMIT = 50;
const TITLE_MAX_CHARS = 120;

const SESSION_COLUMNS =
  "id, workspace_id, owner_user_id, session_type, harness, model, native_session_id, title, folder_name, git_remote, status, started_at, ended_at, end_reason, last_event_at, last_seq, host_machine_id, host_name";

function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string, sessionId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, sessionId, operation: "session", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

async function authorize(workspaceId: string, userId: string): Promise<Response | null> {
  const denied = await assertWorkspaceAccess(workspaceId, userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("workspaces")
    .select("live_sessions_enabled")
    .eq("id", workspaceId)
    .maybeSingle<Pick<WorkspaceRow, "live_sessions_enabled">>();
  if (error) return errorResponse("workspace_lookup_failed", 500, error, workspaceId);
  if (!data?.live_sessions_enabled) return errorResponse("live_sessions_disabled", 403);
  return null;
}

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

async function readBody(req: Request): Promise<BodyResult> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: errorResponse("body_too_large", 413) };

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: errorResponse("invalid_body", 400) };
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { ok: false, response: errorResponse("body_too_large", 413) };

  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return { ok: true, body };
  } catch {
    // falls through to invalid_body
  }
  return { ok: false, response: errorResponse("invalid_body", 400) };
}

function optionalString(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

type OwnedSession = { ok: true; session: SessionRow } | { ok: false; response: Response };

async function loadOwnedSession(workspaceId: string, sessionId: string, userId: string): Promise<OwnedSession> {
  const { data, error } = await serviceClient
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<SessionRow>();
  if (error) return { ok: false, response: errorResponse("session_lookup_failed", 500, error, workspaceId, sessionId) };
  if (!data) return { ok: false, response: errorResponse("session_not_found", 404) };
  if (data.owner_user_id !== userId) return { ok: false, response: errorResponse("not_session_owner", 403) };
  return { ok: true, session: data };
}

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

function isLiveLineInput(value: unknown): value is LiveLineInput {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return typeof line.file === "string" && Number.isInteger(line.offset) && typeof line.raw === "string";
}

const APPEND_ERRORS: Record<string, { error: string; status: number }> = {
  session_not_found: { error: "session_not_found", status: 404 },
  session_ended: { error: "session_ended", status: 409 },
  foreign_host: { error: "foreign_host", status: 403 },
};

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
  if (!Array.isArray(body.lines) || body.lines.length > MAX_LINES_PER_POST || !body.lines.every(isLiveLineInput)) {
    return errorResponse("invalid_lines", 400);
  }

  const events = (body.lines as LiveLineInput[])
    .map(parseLiveLine)
    .filter((event) => event !== null)
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
      const known = Object.entries(APPEND_ERRORS).find(([token]) => error.message.includes(token))?.[1];
      if (known) return errorResponse(known.error, known.status);
      return errorResponse("append_failed", 500, error, workspaceId, sessionId);
    }
    ({ last_seq: lastSeq, inserted } = data as { last_seq: number; inserted: number });
  } else if (owned.session.host_machine_id !== hostMachineId) {
    return errorResponse("foreign_host", 403);
  }

  const firstPrompt = events.find((e) => e.kind === "user_message");
  const nativeSessionId = optionalString(body.nativeSessionId, 200);
  if (owned.session.title === null && firstPrompt) {
    const title = firstLine((firstPrompt.payload as { text: string }).text);
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
    .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: optionalString(parsed.body.reason, 100) ?? "ended" })
    .eq("id", sessionId)
    .neq("status", "ended");
  if (error) return errorResponse("session_end_failed", 500, error, workspaceId, sessionId);

  return Response.json({ ok: true });
});
