import type { HostCaller } from "../auth/with-host-auth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import type { LiveSessionErrorCode } from "draft-core/live-sessions";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import type { SessionRow } from "../types/tables";
import { loadDisplayNames } from "./session-display-names";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export const SESSION_COLUMNS =
  "id, workspace_id, owner_user_id, session_type, harness, model, reasoning_effort, native_session_id, previous_session_id, title, folder_name, git_remote, status, started_at, ended_at, end_reason, resume_request_id, last_failure, last_event_at, last_seen, last_seq, open_approval_count, host_id, host_name, harness_version, raw_storage_path, raw_uploaded_at, permission_mode, approval_mode, runtime, seed";

export function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string, sessionId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, sessionId, operation: "session", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

export async function authorize(workspaceId: string, userId: string): Promise<Response | null> {
  return assertWorkspaceAccess(workspaceId, userId);
}

/** Postgres errors the live-session functions raise on purpose, and the status each one gets. */
const DB_ERROR_STATUS: Partial<Record<LiveSessionErrorCode, number>> = {
  session_not_found: 404,
  session_ended: 409,
  session_sleeping: 409,
  request_not_found: 404,
  queue_full: 429,
  foreign_host: 403,
  routine_read_only: 409,
};

export function knownDbError(message: string): Response | null {
  const token = (Object.keys(DB_ERROR_STATUS) as LiveSessionErrorCode[]).find((t) => message.includes(t));
  return token ? errorResponse(token, DB_ERROR_STATUS[token]!) : null;
}

export async function authorName(userId: string): Promise<string> {
  const names = await loadDisplayNames(serviceClient, [userId], []);
  return names.ok ? (names.users.get(userId) ?? "A teammate") : "A teammate";
}

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

export async function readBody(req: Request): Promise<BodyResult> {
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

export function optionalString(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export type OwnedSession = { ok: true; session: SessionRow } | { ok: false; response: Response };

async function loadSession(workspaceId: string, sessionId: string): Promise<OwnedSession> {
  const { data, error } = await serviceClient
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .maybeSingle<SessionRow>();
  if (error) return { ok: false, response: errorResponse("session_lookup_failed", 500, error, workspaceId, sessionId) };
  if (!data) return { ok: false, response: errorResponse("session_not_found", 404) };
  return { ok: true, session: data };
}

export async function loadOwnedSession(workspaceId: string, sessionId: string, userId: string): Promise<OwnedSession> {
  const loaded = await loadSession(workspaceId, sessionId);
  if (!loaded.ok) return loaded;
  if (loaded.session.owner_user_id !== userId) return { ok: false, response: errorResponse("not_session_owner", 403) };
  return loaded;
}

/** Checks access and loads the owner's session together. The access answer comes first. */
export async function authorizeOwned(workspaceId: string, sessionId: string, userId: string): Promise<OwnedSession> {
  const [denied, owned] = await Promise.all([authorize(workspaceId, userId), loadOwnedSession(workspaceId, sessionId, userId)]);
  return denied ? { ok: false, response: denied } : owned;
}

export type HostSession = { ok: true; caller: HostCaller; session: SessionRow; ownerUserId: string } | { ok: false; response: Response };

/**
 * Access for a host route that reads the session. A person must own it. A cloud run's token already binds it
 * to its session, so only the session is loaded for it.
 */
export async function authorizeHostSession(workspaceId: string, sessionId: string, caller: HostCaller): Promise<HostSession> {
  if (caller.kind === "user") {
    const owned = await authorizeOwned(workspaceId, sessionId, caller.userId);
    if (!owned.ok) return owned;
    return { ok: true, caller, session: owned.session, ownerUserId: caller.userId };
  }
  const loaded = await loadSession(workspaceId, sessionId);
  if (!loaded.ok) return loaded;
  return { ok: true, caller, session: loaded.session, ownerUserId: caller.ownerUserId };
}

export type HostMember = { ok: true; ownerUserId: string } | { ok: false; response: Response };

/** Access for a host route that checks only team membership. The database checks the owner and the host. */
export async function authorizeHostMember(workspaceId: string, caller: HostCaller): Promise<HostMember> {
  if (caller.kind === "cloud_host") return { ok: true, ownerUserId: caller.ownerUserId };
  const denied = await authorize(workspaceId, caller.userId);
  return denied ? { ok: false, response: denied } : { ok: true, ownerUserId: caller.userId };
}

/**
 * The host id a host request acts for. A cloud run acts only for its own host, so a body that names
 * another host is refused. A person's request keeps the host it names.
 */
export function hostIdFor(caller: HostCaller, given: string | null): { ok: true; hostId: string | null } | { ok: false; response: Response } {
  if (caller.kind === "user") return { ok: true, hostId: given };
  if (given !== null && given !== caller.hostId) return { ok: false, response: errorResponse("foreign_host", 403) };
  return { ok: true, hostId: caller.hostId };
}
