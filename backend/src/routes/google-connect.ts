import type { SupabaseClient } from "@supabase/supabase-js";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { createGoogleOAuthSession, getGoogleOAuthSession } from "../auth/google-oauth-state-store";
import { googleOAuthSettings } from "../config";
import { serviceClient } from "../db/client";
import { buildGoogleAuthUrl, generatePkcePair } from "../ingestion/google/oauth";
import { recordRouteError } from "../errors/route-error";

type CreateSessionRequest = Bun.BunRequest<"/workspaces/:id/google/connect-sessions">;
type PollSessionRequest = Bun.BunRequest<"/workspaces/:id/google/connect-sessions/:code">;

export interface GoogleConnectDependencies {
  settings: typeof googleOAuthSettings;
  db: SupabaseClient;
}

const defaultDependencies: GoogleConnectDependencies = { settings: googleOAuthSettings, db: serviceClient };

export async function createGoogleConnectSession(
  workspaceId: string,
  userId: string,
  deps: GoogleConnectDependencies = defaultDependencies,
): Promise<Response> {
  const settings = deps.settings();
  if (!settings) return Response.json({ error: "google_oauth_not_configured" }, { status: 503 });

  // A degraded connection may connect again to fix an expired grant; the
  // callback upserts the same row.
  const { data: existing, error: existingError } = await deps.db
    .from("connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "gmail")
    .eq("connected_by_user_id", userId)
    .eq("status", "active")
    .limit(1);
  if (existingError) {
    recordRouteError({ workspaceId, operation: "auth", errorCode: "gmail_connect_lookup_failed", error: existingError });
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  if ((existing ?? []).length > 0) {
    return Response.json({ error: "google_already_connected" }, { status: 409 });
  }

  // The sign-in email is only a hint: the connected mailbox may differ.
  const { data: user } = await deps.db
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle<{ email: string | null }>();

  const { verifier, challenge } = generatePkcePair();
  const state = createGoogleOAuthSession(workspaceId, userId, verifier);
  return Response.json({
    code: state,
    authUrl: buildGoogleAuthUrl(settings, { state, codeChallenge: challenge, loginHint: user?.email }),
  });
}

// Authenticated, workspace-scoped and user-scoped: a leaked code alone cannot read status.
export function pollGoogleConnectSession(workspaceId: string, userId: string, code: string): Response {
  const session = getGoogleOAuthSession(code);
  if (session.status === "expired_or_unknown") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (session.workspaceId !== workspaceId || session.userId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (session.status === "pending") return Response.json({ status: "pending" });
  return Response.json({
    status: session.status,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
  });
}

export const createPOST = withAuth<CreateSessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return createGoogleConnectSession(req.params.id, caller.userId);
});

export const pollGET = withAuth<PollSessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return pollGoogleConnectSession(req.params.id, caller.userId, req.params.code);
});
