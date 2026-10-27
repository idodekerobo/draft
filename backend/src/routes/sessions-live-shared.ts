import { assertWorkspaceAccess } from "../auth/workspace-access";
import type { LiveSessionErrorCode } from "draft-core/live-sessions";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import type { SessionRow, WorkspaceRow } from "../types/tables";
import { loadDisplayNames } from "./session-display-names";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export const SESSION_COLUMNS =
  "id, workspace_id, owner_user_id, session_type, harness, model, native_session_id, title, folder_name, git_remote, status, started_at, ended_at, end_reason, last_event_at, last_seq, open_approval_count, host_machine_id, host_name, raw_storage_path, raw_uploaded_at";

export function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string, sessionId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, sessionId, operation: "session", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

export async function authorize(workspaceId: string, userId: string): Promise<Response | null> {
  const [denied, flag] = await Promise.all([
    assertWorkspaceAccess(workspaceId, userId),
    serviceClient.from("workspaces").select("live_sessions_enabled").eq("id", workspaceId).maybeSingle<Pick<WorkspaceRow, "live_sessions_enabled">>(),
  ]);
  if (denied) return denied;
  if (flag.error) return errorResponse("workspace_lookup_failed", 500, flag.error, workspaceId);
  if (!flag.data?.live_sessions_enabled) return errorResponse("live_sessions_disabled", 403);
  return null;
}

/** Postgres errors the live-session functions raise on purpose, and the status each one gets. */
const DB_ERROR_STATUS: Partial<Record<LiveSessionErrorCode, number>> = {
  session_not_found: 404,
  session_ended: 409,
  request_not_found: 404,
  queue_full: 429,
  foreign_host: 403,
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

export async function loadOwnedSession(workspaceId: string, sessionId: string, userId: string): Promise<OwnedSession> {
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
