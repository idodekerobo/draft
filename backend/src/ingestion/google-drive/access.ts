import type { SupabaseClient } from "@supabase/supabase-js";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../config";
import { CredentialError, resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import { recordError } from "../../errors/record-error";
import { GoogleOAuthError, refreshGoogleAccessToken } from "../google/oauth";
import { createDriveApi, type DriveApi } from "./api";

export type DriveAccessFailureCode = "drive_not_connected" | "google_reconnect_required" | "google_oauth_not_configured";

export type DriveAccess =
  | { ok: true; api: DriveApi }
  | { ok: false; code: DriveAccessFailureCode; message: string };

export interface DriveAccessDependencies {
  settings?: () => GoogleOAuthSettings | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const NOT_CONNECTED_MESSAGE = "Connect Google with Google Drive access: draft connections connect google";
const RECONNECT_MESSAGE = "Reconnect Google";

// Uses only the user's own Google Drive login. The access token lives only in the returned client.
export async function driveAccessFor(
  client: SupabaseClient,
  workspaceId: string,
  userId: string,
  deps: DriveAccessDependencies = {},
): Promise<DriveAccess> {
  const { data, error } = await client
    .from("connections")
    .select("id, credential_id, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", "google_drive")
    .eq("connected_by_user_id", userId)
    .in("status", ["active", "degraded"])
    .limit(1);
  if (error) throw error;
  const connection = ((data ?? []) as Array<{ id: string; credential_id: string | null; status: string }>)[0];
  if (!connection) return { ok: false, code: "drive_not_connected", message: NOT_CONNECTED_MESSAGE };

  const settings = (deps.settings ?? googleOAuthSettings)();
  if (!settings) return { ok: false, code: "google_oauth_not_configured", message: "Google sign-in is not set up on this Draft server." };

  const now = deps.now ?? (() => new Date());
  const markDegraded = async (reason: string, cause?: unknown) => {
    const wasActive = connection.status === "active";
    const { error: updateError } = await client
      .from("connections")
      .update({ status: "degraded", last_error_at: now().toISOString() })
      .eq("id", connection.id)
      .in("status", ["active", "degraded"]);
    if (updateError) throw updateError;
    if (wasActive) {
      await recordError({
        client, workspaceId, connectionId: connection.id, operation: "auth", code: "drive_access_degraded",
        message: "Google Drive access needs a Google reconnect", detail: { reason }, error: cause,
      });
    }
    return { ok: false as const, code: "google_reconnect_required" as const, message: RECONNECT_MESSAGE };
  };

  if (!connection.credential_id) return markDegraded("missing_credential");

  let refreshToken: string;
  try {
    const credential = await resolveProviderCredentialById(workspaceId, "google_drive", connection.credential_id, client);
    refreshToken = credential.refresh_token;
  } catch (cause) {
    if (cause instanceof CredentialError) return markDegraded("credential_unusable", cause);
    throw cause;
  }

  let accessToken: string;
  try {
    accessToken = (await refreshGoogleAccessToken(settings, refreshToken, deps.fetchImpl ?? fetch)).accessToken;
  } catch (cause) {
    if (cause instanceof GoogleOAuthError && cause.code === "invalid_grant") return markDegraded("invalid_grant", cause);
    throw cause;
  }

  if (connection.status === "degraded") {
    const { error: updateError } = await client
      .from("connections")
      .update({ status: "active", last_success_at: now().toISOString() })
      .eq("id", connection.id)
      .eq("status", "degraded");
    if (updateError) throw updateError;
  }

  return { ok: true, api: createDriveApi(accessToken, deps.fetchImpl ?? fetch) };
}
