import type { SupabaseClient } from "@supabase/supabase-js";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { createGoogleOAuthSession, getGoogleOAuthSession, type GoogleConnectProduct } from "../auth/google-oauth-state-store";
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
  product?: GoogleConnectProduct,
): Promise<Response> {
  const settings = deps.settings();
  if (!settings) return Response.json({ error: "google_oauth_not_configured" }, { status: 503 });

  // A degraded connection may connect again to fix an expired grant, and a
  // person with only one Google product may connect again to add the other.
  const { data: existing, error: existingError } = await deps.db
    .from("connections")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .in("provider", ["gmail", "google_drive"])
    .eq("connected_by_user_id", userId)
    .eq("status", "active");
  if (existingError) {
    recordRouteError({ workspaceId, operation: "auth", errorCode: "gmail_connect_lookup_failed", error: existingError });
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  const activeProviders = new Set(((existing ?? []) as Array<{ provider: string }>).map((row) => row.provider));
  if (activeProviders.has("gmail") && activeProviders.has("google_drive")) {
    return Response.json({ error: "google_already_connected" }, { status: 409 });
  }

  // The sign-in email is only a hint: the connected mailbox may differ.
  const { data: user } = await deps.db
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle<{ email: string | null }>();

  const { verifier, challenge } = generatePkcePair();
  const state = createGoogleOAuthSession(workspaceId, userId, verifier, product);
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
  const body = (await req.json().catch(() => null)) as { product?: unknown } | null;
  const product = body?.product;
  if (product !== undefined && product !== "gmail" && product !== "google_drive") {
    return Response.json({ error: "invalid_product" }, { status: 400 });
  }
  return createGoogleConnectSession(req.params.id, caller.userId, defaultDependencies, product);
});

export const pollGET = withAuth<PollSessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return pollGoogleConnectSession(req.params.id, caller.userId, req.params.code);
});
