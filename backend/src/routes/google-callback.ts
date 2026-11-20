import type { SupabaseClient } from "@supabase/supabase-js";
import { getGoogleOAuthSession, resolveGoogleOAuthSession } from "../auth/google-oauth-state-store";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../config";
import { CURRENT_CREDENTIAL_KEY_VERSION, encryptCredentialPayload } from "../credentials/crypto";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { DRIVE_READONLY_SCOPE, exchangeGoogleCode, GMAIL_READONLY_SCOPE, GoogleOAuthError, verifyGoogleIdToken } from "../ingestion/google/oauth";
import { registerDriveSyncTask } from "../ingestion/google-drive/register-task";
import { upsertConnection } from "../ingestion/upsert-source-item";
import { oauthResultResponse } from "./oauth-result-page";
import type { ConnectionRow } from "../types/tables";

const failed = (message: string) =>
  oauthResultResponse({
    kind: "error",
    heading: "Google was not connected",
    message,
    next: { heading: "What to do", message: "Return to Draft and try connecting again from Connections." },
  });

export interface GoogleCallbackDependencies {
  settings: () => GoogleOAuthSettings | null;
  exchangeCode: typeof exchangeGoogleCode;
  verifyIdToken: typeof verifyGoogleIdToken;
  upsertConnection: typeof upsertConnection;
  registerDriveSyncTask: typeof registerDriveSyncTask;
  db: SupabaseClient;
}

const defaultDependencies: GoogleCallbackDependencies = {
  settings: googleOAuthSettings,
  exchangeCode: exchangeGoogleCode,
  verifyIdToken: verifyGoogleIdToken,
  upsertConnection,
  registerDriveSyncTask,
  db: serviceClient,
};

// Each granted Google product gets its own connection; all share one credential row.
const PRODUCTS = [
  { provider: "gmail", scope: GMAIL_READONLY_SCOPE, label: "Gmail", noun: "mailbox", codePrefix: "gmail", teammateCode: "gmail_mailbox_already_connected" },
  { provider: "google_drive", scope: DRIVE_READONLY_SCOPE, label: "Google Drive", noun: "Google account", codePrefix: "drive", teammateCode: "drive_account_already_connected" },
] as const;

class ConnectRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// The one redirect URI registered with Google. Unauthenticated (a browser
// redirect), so everything is bound to the stored state and the verified id_token.
export async function handleGoogleCallback(
  request: Request,
  deps: GoogleCallbackDependencies = defaultDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) {
    return oauthResultResponse({ kind: "error", heading: "This link is not valid", message: "The sign-in link is missing its state. Start again from Connections in Draft." }, 400);
  }

  const session = getGoogleOAuthSession(state);
  if (session.status !== "pending") {
    return oauthResultResponse({
      kind: "error",
      heading: "This link has expired",
      message: "This connect link has expired or was already used. Start again from Connections in Draft.",
    });
  }

  const fail = (errorCode: string, errorMessage: string) => {
    resolveGoogleOAuthSession(state, { status: "error", errorCode, errorMessage });
    return failed(errorMessage);
  };

  if (url.searchParams.get("error")) {
    return fail("google_access_denied", "Google access was not granted.");
  }
  const code = url.searchParams.get("code");
  const settings = deps.settings();
  if (!code || !settings) return fail("google_callback_invalid", "Google did not return an authorization code.");

  try {
    const tokens = await deps.exchangeCode(settings, { code, codeVerifier: session.codeVerifier });
    if (!tokens.refreshToken || !tokens.idToken) {
      throw new ConnectRejected("google_no_refresh_token", "Google did not return a refresh token. Try connecting again.");
    }
    const granted = PRODUCTS.filter((product) => tokens.scopes.includes(product.scope));
    if (granted.length === 0) {
      throw new ConnectRejected("google_scope_missing", "Gmail or Google Drive access was not granted. Allow at least one and try again.");
    }
    const identity = await deps.verifyIdToken(tokens.idToken, settings.clientId);

    const { data: rows, error: rowsError } = await deps.db
      .from("connections")
      .select("id, provider, connection_key, credential_id, connected_by_user_id, status")
      .eq("workspace_id", session.workspaceId)
      .in("provider", PRODUCTS.map((product) => product.provider))
      .neq("status", "revoked");
    if (rowsError) throw rowsError;
    const live = (rows ?? []) as Pick<
      ConnectionRow,
      "id" | "provider" | "connection_key" | "credential_id" | "connected_by_user_id" | "status"
    >[];

    for (const product of granted) {
      const ofProduct = live.filter((row) => row.provider === product.provider);
      const sameAccount = ofProduct.find((row) => row.connection_key === identity.sub);
      if (sameAccount && sameAccount.connected_by_user_id !== session.userId) {
        throw new ConnectRejected(product.teammateCode, `This ${product.noun} is already connected by a teammate.`);
      }
      if (ofProduct.some((row) => row.connected_by_user_id === session.userId && row.connection_key !== identity.sub)) {
        throw new ConnectRejected(
          `${product.codePrefix}_already_connected`,
          `You already have a ${product.noun} connected for ${product.label}. Disconnect it first.`,
        );
      }
    }

    const encrypted = encryptCredentialPayload(
      JSON.stringify({ refresh_token: tokens.refreshToken, scopes: tokens.scopes }),
      CURRENT_CREDENTIAL_KEY_VERSION,
    );
    let credentialId = live.find((row) => row.connection_key === identity.sub && row.credential_id)?.credential_id ?? null;
    if (credentialId) {
      const { error } = await deps.db
        .from("credentials")
        .update({ encrypted_payload: encrypted, encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION, status: "active" })
        .eq("id", credentialId)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;
    } else {
      const { data, error } = await deps.db
        .from("credentials")
        .insert({
          workspace_id: session.workspaceId,
          provider: "google",
          encrypted_payload: encrypted,
          encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
          status: "active",
          created_by_user_id: session.userId,
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("credential_insert_failed");
      credentialId = (data as { id: string }).id;
    }

    for (const product of granted) {
      const connection = await deps.upsertConnection(deps.db, {
        workspace_id: session.workspaceId,
        provider: product.provider,
        connection_key: identity.sub,
        display_name: identity.email,
        external_account_id: identity.sub,
        status: "active",
        credential_id: credentialId,
        connected_by_user_id: session.userId,
      });
      if (product.provider === "google_drive") {
        await deps.registerDriveSyncTask({ id: connection.id, workspace_id: connection.workspace_id }, deps.db);
      }
    }

    resolveGoogleOAuthSession(state, { status: "connected" });
    const hasDrive = granted.some((product) => product.provider === "google_drive");
    const hasGmail = granted.some((product) => product.provider === "gmail");
    const next = [
      hasGmail ? "Your agent searches and reads your mail only when you ask. Draft stores no mail." : null,
      hasDrive ? "Choose the Google Drive folders to sync in Connections. Every file in them goes into company context." : null,
      hasGmail ? "If Claude Code was already open, restart it or run /mcp to see the Gmail tools." : null,
    ].filter(Boolean).join(" ");
    return oauthResultResponse({
      kind: "success",
      heading: `${granted.map((product) => product.label).join(" and ")} connected`,
      message: "Draft has read-only access. You can return to Draft now.",
      next: { heading: "What happens next", message: next },
    });
  } catch (error) {
    if (error instanceof ConnectRejected) return fail(error.code, error.message);
    recordRouteError({
      workspaceId: session.workspaceId,
      operation: "ingestion",
      errorCode: "google_callback_failed",
      error: error instanceof GoogleOAuthError ? new Error(error.code) : error,
    });
    return fail("google_callback_failed", "Something went wrong connecting Google.");
  }
}

export const GET = (request: Request) => handleGoogleCallback(request);
