import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import type { SessionInputRow } from "../types/tables";
import { authorName, authorize, errorResponse, knownDbError, loadOwnedSession, optionalString, readBody } from "./sessions-live-shared";

type DecisionRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/approvals/:requestId/decision">;
type StopRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/stop">;
type HostEventsRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/host-events">;

const MAX_HOST_EVENTS = 20;
const HOST_EVENT_KINDS = new Set(["permission_request", "permission_resolved", "session_note"]);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Any member can decide an open permission request. The first decision wins. */
export const DECISION = withAuth<DecisionRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId, requestId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;
  if (!REQUEST_ID.test(requestId)) return errorResponse("invalid_request_id", 400);

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const decision = parsed.body.decision;
  if (decision !== "allow" && decision !== "deny") return errorResponse("invalid_decision", 400);

  const { data, error } = await serviceClient.rpc("create_permission_decision", {
    p_session_id: sessionId,
    p_workspace_id: workspaceId,
    p_author_user_id: caller.userId,
    p_author_name: await authorName(caller.userId),
    p_request_id: requestId,
    p_decision: decision,
  });
  if (error) return knownDbError(error.message) ?? errorResponse("decision_failed", 500, error, workspaceId, sessionId);

  const result = data as { outcome: string; by_name?: string; decision?: string; reason?: string };
  if (result.outcome === "created") return Response.json({ ok: true }, { status: 201 });
  if (result.outcome === "already_decided") {
    return Response.json({ ok: false, error: "already_decided", by_name: result.by_name ?? null, decision: result.decision ?? null }, { status: 409 });
  }
  return Response.json({ ok: false, error: "request_closed", reason: result.reason ?? null }, { status: 409 });
});

/** Any member can ask the host to interrupt the running turn. A second Stop while one waits does nothing. */
export const STOP = withAuth<StopRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const { data: waiting, error: waitingError } = await serviceClient
    .from("session_inputs")
    .select("id")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "stop")
    .in("state", ["queued", "delivering"]);
  if (waitingError) return errorResponse("stop_failed", 500, waitingError, workspaceId, sessionId);
  if (((waiting ?? []) as Pick<SessionInputRow, "id">[]).length > 0) return Response.json({ ok: true, already_requested: true });

  const { error } = await serviceClient.rpc("create_session_input", {
    p_session_id: sessionId,
    p_workspace_id: workspaceId,
    p_author_user_id: caller.userId,
    p_author_name: await authorName(caller.userId),
    p_kind: "stop",
    p_payload: {},
  });
  if (error) return knownDbError(error.message) ?? errorResponse("stop_failed", 500, error, workspaceId, sessionId);
  return Response.json({ ok: true }, { status: 201 });
});

type HostEvent = { sourceId: string; kind: string; payload: Record<string, unknown> };

function isHostEvent(value: unknown): value is HostEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.sourceId === "string" &&
    event.sourceId.length > 0 &&
    event.sourceId.length <= 200 &&
    typeof event.kind === "string" &&
    HOST_EVENT_KINDS.has(event.kind) &&
    !!event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
  );
}

/** The host reports what only it can see: a permission request, how one ended, a note such as a Stop. */
export const HOST_EVENTS = withAuth<HostEventsRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const hostMachineId = optionalString(parsed.body.hostMachineId, 200);
  if (!hostMachineId) return errorResponse("missing_host_machine_id", 400);
  const events = parsed.body.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_HOST_EVENTS || !events.every(isHostEvent)) {
    return errorResponse("invalid_events", 400);
  }

  const { data, error } = await serviceClient.rpc("append_session_events", {
    p_session_id: sessionId,
    p_workspace_id: workspaceId,
    p_host_machine_id: hostMachineId,
    p_events: (events as HostEvent[]).map((e) => ({ source_id: e.sourceId, kind: e.kind, payload: e.payload })),
  });
  if (error) return knownDbError(error.message) ?? errorResponse("append_failed", 500, error, workspaceId, sessionId);
  return Response.json({ ok: true, ...(data as { last_seq: number; inserted: number }) });
});
