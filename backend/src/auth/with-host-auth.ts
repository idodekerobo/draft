import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { AgentRunTokenError, verifyAgentRunToken, type AgentRunTokenClaims } from "../metaharness/runs/run-token";
import { runTokenSecret } from "../metaharness/runs/run-token-secret";
import type { VerifiedCaller } from "./verify";
import { withAuth } from "./withAuth";

/** A person's desktop host, or the sandbox host of a cloud session. */
export type HostCaller =
  | ({ kind: "user" } & VerifiedCaller)
  | { kind: "cloud_host"; runId: string; sessionId: string; workspaceId: string; ownerUserId: string; hostId: string };

export type HostRequest = Request & { params: Record<string, string> };

export type HostHandler<Req extends HostRequest> = (req: Req, caller: HostCaller) => Promise<Response> | Response;

/** The host id of a cloud session. Its sessions.host_id holds the same value. */
export const cloudHostId = (sessionId: string): string => `cloud:${sessionId}`;

type Refusal = { ok: false; response: Response };

const refuse = (status: number, error: string): Refusal => ({
  ok: false,
  response: Response.json({ ok: false, error }, { status }),
});

/** An unexpected failure is recorded and answered with 500. A refusal is never recorded. */
async function fail(error: unknown, ids: { workspaceId: string; sessionId: string; agentRunId?: string }, code: string, message: string): Promise<Refusal> {
  await recordError({ workspaceId: ids.workspaceId, sessionId: ids.sessionId, agentRunId: ids.agentRunId, operation: "auth", code, message, error });
  return { ok: false, response: Response.json({ ok: false, error: code }, { status: 500 }) };
}

/**
 * The bearer token when it has the two-part shape of a run token. A person's login is a three-part JWT,
 * so only a token that is not a login reaches the run-token check.
 */
function runTokenCandidate(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.split(".").length === 2 ? token : null;
}

type RunAuthRow = { id: string; workspace_id: string; kind: string; status: string; session_id: string | null };
type SessionAuthRow = { owner_user_id: string; runtime: string; host_id: string };

/**
 * Checks a run token and the run and session it names. Every failed check is a refusal, and none of them
 * falls back to a login.
 */
async function cloudHostCaller(req: HostRequest, token: string): Promise<{ ok: true; caller: HostCaller } | Refusal> {
  const workspaceId = req.params.id;
  const sessionId = req.params.sessionId;

  let claims: AgentRunTokenClaims;
  try {
    claims = verifyAgentRunToken(token, runTokenSecret());
  } catch (error) {
    if (error instanceof AgentRunTokenError) return refuse(401, "invalid_run_token");
    return fail(error, { workspaceId, sessionId }, "host_token_check_failed", "A host request's run token could not be checked");
  }
  // The agent's MCP token and a routine's token must not reach the host endpoints, so only a host token passes.
  if (claims.scope !== "host") return refuse(403, "token_scope");

  const { data: run, error: runError } = await serviceClient
    .from("agent_runs")
    .select("id, workspace_id, kind, status, session_id")
    .eq("id", claims.runId)
    .maybeSingle<RunAuthRow>();
  if (runError) {
    return fail(runError, { workspaceId: claims.workspaceId, sessionId, agentRunId: claims.runId }, "host_run_lookup_failed", "A host request's run could not be loaded");
  }
  if (!run) return refuse(401, "invalid_run_token");
  if (claims.workspaceId !== workspaceId || run.workspace_id !== workspaceId || run.session_id !== sessionId) {
    return refuse(403, "run_not_for_session");
  }
  if (run.kind !== "interactive") return refuse(403, "run_not_interactive");
  if (!(ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(run.status)) return refuse(403, "run_not_active");

  const { data: session, error: sessionError } = await serviceClient
    .from("sessions")
    .select("owner_user_id, runtime, host_id")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .maybeSingle<SessionAuthRow>();
  if (sessionError) return fail(sessionError, { workspaceId, sessionId, agentRunId: claims.runId }, "host_session_lookup_failed", "A host request's session could not be loaded");
  if (!session) return refuse(404, "session_not_found");
  if (session.runtime !== "cloud") return refuse(403, "session_not_cloud");

  const hostId = cloudHostId(sessionId);
  if (session.host_id !== hostId) return refuse(403, "foreign_host");
  return {
    ok: true,
    caller: { kind: "cloud_host", runId: claims.runId, sessionId, workspaceId, ownerUserId: session.owner_user_id, hostId },
  };
}

/**
 * Authenticates a host endpoint. A run token binds the request to one cloud session. Any other request
 * goes through withAuth, the same check as before.
 */
export function withHostAuth<Req extends HostRequest = HostRequest>(handler: HostHandler<Req>) {
  const asUser = withAuth<Req>((req, caller) => handler(req, { kind: "user", ...caller }));
  return async (req: Req): Promise<Response> => {
    const token = runTokenCandidate(req.headers);
    if (token === null) return asUser(req);
    const cloud = await cloudHostCaller(req, token);
    if (!cloud.ok) return cloud.response;
    return handler(req, cloud.caller);
  };
}
