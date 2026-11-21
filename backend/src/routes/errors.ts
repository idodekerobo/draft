import { SESSION_FAILURES, sessionFailureMessage, type SessionFailureCode } from "draft-core/session-failure";
import { withHostAuth } from "../auth/with-host-auth";
import { serviceClient } from "../db/client";
import { errorSanitizer, recordError } from "../errors/record-error";
import type { ErrorOperation } from "../types/enums";
import { authorize, authorizeHostSession, errorResponse, hostIdFor, knownDbError } from "./sessions-live-shared";
import { failQueuedInputs } from "./sessions-live-inputs";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const operations = new Set(["ingestion", "scheduling", "queue", "execution", "validation", "commit", "projection", "auth", "read", "session"]);
type Body = Record<string, any>;

export const POST = async (req: Bun.BunRequest<"/workspaces/:id/errors">): Promise<Response> => {
  const raw = await req.text();
  if (raw.length > 8192) return errorResponse("body_too_large", 413);
  let body: Body;
  try { body = JSON.parse(raw); } catch { return errorResponse("invalid_body", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !uuid(body.id)
    || typeof body.code !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(body.code)
    || typeof body.message !== "string" || !body.message || body.message.length > 1000
    || !operations.has(body.operation) || (body.sessionId != null && !uuid(body.sessionId))
    || (body.detail != null && (typeof body.detail !== "object" || Array.isArray(body.detail)))) return errorResponse("invalid_error", 400);

  // A cloud token must still be bound to the session named in the report.
  const request = Object.assign(new Request(req.url, { method: req.method, headers: req.headers }), {
    params: { id: req.params.id, ...(body.sessionId ? { sessionId: body.sessionId } : {}) },
  });
  return withHostAuth(async (authenticated, caller) => {
    const workspaceId = authenticated.params.id;
    const sessionId = body.sessionId as string | undefined;
    const owned = sessionId ? await authorizeHostSession(workspaceId, sessionId, caller) : null;
    if (owned && !owned.ok) return owned.response;
    if (!owned && caller.kind === "user") {
      const denied = await authorize(workspaceId, caller.userId);
      if (denied) return denied;
    }
    if (!body.sessionFailure) {
      const saved = await recordError({ errorId: body.id, workspaceId, sessionId,
        agentRunId: caller.kind === "cloud_host" ? caller.runId : undefined,
        operation: body.operation as ErrorOperation, code: body.code, message: body.message,
        detail: body.detail ?? {},
      });
      return saved ? Response.json({ ok: true }) : errorResponse("error_recording_failed", 503);
    }
    if (!sessionId || !owned?.ok || body.operation !== "session") return errorResponse("invalid_session_failure", 400);
    const target = hostIdFor(caller, typeof body.hostId === "string" ? body.hostId : null);
    if (!target.ok) return target.response;
    if (target.hostId !== owned.session.host_id) return errorResponse("foreign_host", 403);
    const f = body.sessionFailure;
    if ((f.requestId !== null && !uuid(f.requestId)) || !Object.hasOwn(SESSION_FAILURES, body.code)
      || typeof f.at !== "string" || !Number.isFinite(Date.parse(f.at)) || typeof f.terminal !== "boolean"
      || (f.expectedRequestId != null && !uuid(f.expectedRequestId))) return errorResponse("invalid_failure", 400);
    const code = body.code as SessionFailureCode;
    const failure = { id: body.id, requestId: f.requestId, code, at: new Date(f.at).toISOString(), ...SESSION_FAILURES[code], message: sessionFailureMessage(code, owned.session.harness) };
    const d = body.detail ?? {};
    const diagnostics = errorSanitizer.sanitize({
      host_id: target.hostId, harness: owned.session.harness,
      run_id: caller.kind === "cloud_host" ? caller.runId : null,
      phase: ["resume", "launch", "reconnect", ...Object.keys(SESSION_FAILURES)].includes(d.phase) ? d.phase : "unknown",
      errorName: typeof d.errorName === "string" ? d.errorName.slice(0, 100) : null,
      reason: ["timeout", "connection_closed", "tmux_launch_failed", "missing_folder_or_transcript", "rpc_rejected", "unknown"].includes(d.reason) ? d.reason : "unknown",
      ...Object.fromEntries(["transportCode", "exitCode", "status"].filter(key => typeof d[key] === "number" && Number.isFinite(d[key])).map(key => [key, d[key]])),
    });
    const { data, error } = await serviceClient.rpc("report_session_failure", {
      p_session_id: sessionId, p_workspace_id: workspaceId, p_host_id: target.hostId,
      p_failure: failure, p_diagnostics: diagnostics, p_terminal: f.terminal && (caller.kind !== "cloud_host" || caller.runActive !== false),
      p_expected_request_id: f.expectedRequestId ?? null,
    });
    if (error) return knownDbError(error.message) ?? errorResponse("failure_report_failed", 500, error, workspaceId, sessionId);
    if ((data as { terminal_applied?: boolean })?.terminal_applied) await failQueuedInputs(sessionId, "session_ended");
    return Response.json({ ok: true });
  }, { allowFinishedRun: true })(request);
};
