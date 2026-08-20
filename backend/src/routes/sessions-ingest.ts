import { basename } from "node:path";
import { publishableClient, serviceClient } from "../db/client";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { resolveWorkspaceFromIngestToken } from "../credentials/session-ingest-token";
import { CLAUDE_SESSION_CONNECTION_KEY } from "../ingestion/agent-sessions/constants";
import { parseClaudeCodeJsonl } from "../ingestion/claude-code/parse-transcript";
import { persistAgentSession } from "../ingestion/agent-sessions/persist-session";
import { recordRouteError } from "../errors/route-error";

// The ingest route's `source` literal for Claude Code sessions -- same
// fragile-but-scoped string match already implicit elsewhere in this path.
const CLAUDE_CODE_SESSION_SOURCE = "claude-code-session";

async function isSessionTrackingEnabled(workspaceId: string, source: string): Promise<boolean> {
  if (source !== CLAUDE_CODE_SESSION_SOURCE) return true;
  const { data } = await serviceClient
    .from("source_connections")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("provider", "claude_session")
    .eq("connection_key", CLAUDE_SESSION_CONNECTION_KEY)
    .maybeSingle<{ status: string }>();
  return data?.status === "active" || data?.status === "pending";
}

type SessionsIngestRequest = Bun.BunRequest<"/sessions/ingest">;

interface SessionContributorRow {
  id: string;
}

function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, operation: "ingestion", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

async function resolveIdentity(
  workspaceId: string,
  userToken: string | null,
  gitEmail: string,
  displayName: string | null,
): Promise<{ userId: string | null; contributorId: string | null } | Response> {
  if (userToken) {
    const { data, error } = await publishableClient.auth.getUser(userToken);
    if (!error && data.user) {
      const denied = await assertWorkspaceAccess(workspaceId, data.user.id);
      if (!denied) return { userId: data.user.id, contributorId: null };
    }
    // Invalid token or membership mismatch: fall through to contributor tier
    // rather than reject outright — the ingest token already authorized the
    // write, this only decides attribution.
  }

  const { data: existing, error: lookupError } = await serviceClient
    .from("session_contributors")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("git_email", gitEmail)
    .maybeSingle<SessionContributorRow>();
  if (lookupError) return errorResponse("contributor_lookup_failed", 500, lookupError, workspaceId);

  const now = new Date().toISOString();
  if (existing) {
    const { error: updateError } = await serviceClient
      .from("session_contributors")
      .update({ last_seen_at: now, ...(displayName ? { git_display_name: displayName } : {}) })
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId);
    if (updateError) return errorResponse("contributor_update_failed", 500, updateError, workspaceId);
    return { userId: null, contributorId: existing.id };
  }

  const { data: inserted, error: insertError } = await serviceClient
    .from("session_contributors")
    .insert({
      workspace_id: workspaceId,
      git_email: gitEmail,
      git_display_name: displayName,
      first_seen_at: now,
      last_seen_at: now,
    })
    .select("id")
    .single<SessionContributorRow>();
  if (insertError || !inserted) return errorResponse("contributor_insert_failed", 500, insertError, workspaceId);
  return { userId: null, contributorId: inserted.id };
}

export const POST = async (req: SessionsIngestRequest): Promise<Response> => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("missing_ingest_token", 401);
  const ingestToken = authHeader.slice("Bearer ".length).trim();
  if (!ingestToken) return errorResponse("missing_ingest_token", 401);

  const workspaceId = await resolveWorkspaceFromIngestToken(serviceClient, ingestToken);
  if (!workspaceId) return errorResponse("invalid_ingest_token", 401);

  const params = new URL(req.url).searchParams;
  const sessionId = params.get("sessionId")?.trim();
  const gitEmail = params.get("gitEmail")?.trim();
  if (!sessionId || !gitEmail) return errorResponse("missing_required_fields", 400, undefined, workspaceId);

  const cwd = params.get("cwd");
  const displayName = params.get("displayName")?.trim() || null;
  const status = params.get("status") || "unknown";
  const source = params.get("source") || CLAUDE_CODE_SESSION_SOURCE;
  const project = cwd ? basename(cwd) : null;

  // The ingest token is valid -- this is a workspace policy rejection, not an auth failure.
  if (!(await isSessionTrackingEnabled(workspaceId, source))) {
    return errorResponse("session_tracking_disabled", 403, undefined, workspaceId);
  }

  const userToken = req.headers.get("x-draft-user-token");
  const identity = await resolveIdentity(workspaceId, userToken, gitEmail, displayName);
  if (identity instanceof Response) return identity;

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return errorResponse("invalid_body", 400, undefined, workspaceId);
  }

  const parsed = parseClaudeCodeJsonl(raw);
  if (parsed.messages.length === 0) return Response.json({ ok: true, skipped: "empty" });

  const startedAt = parsed.startedAt ?? parsed.endedAt ?? new Date().toISOString();

  try {
    const { sessionId: agentSessionId } = await persistAgentSession(serviceClient, {
      workspace_id: workspaceId,
      provider: source,
      external_session_id: sessionId,
      user_id: identity.userId,
      contributor_id: identity.contributorId,
      project,
      cwd: cwd ?? null,
      started_at: startedAt,
      ended_at: parsed.endedAt,
      status,
      messages: parsed.messages,
    });
    return Response.json({ ok: true, sessionId: agentSessionId });
  } catch (err) {
    return errorResponse("persist_failed", 500, err, workspaceId);
  }
};
