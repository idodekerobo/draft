import type { SupabaseClient } from "@supabase/supabase-js";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../config";
import { CredentialError, resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import { GoogleOAuthError, refreshGoogleAccessToken } from "../google/oauth";
import { workspaceProvider } from "../../metaharness/tools/tool-registry";
import { createGmailApi, type GmailApi } from "./api";

export type GmailAccessFailureCode = "google_not_connected" | "google_reconnect_required" | "google_oauth_not_configured";

export type GmailAccess =
  | { ok: true; api: GmailApi }
  | { ok: false; code: GmailAccessFailureCode; message: string };

export interface GmailAccessDependencies {
  settings?: () => GoogleOAuthSettings | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const NOT_CONNECTED_MESSAGE = "Connect Google to let your agent read your Gmail: draft connections connect --provider google";
const RECONNECT_MESSAGE = "Reconnect Google";

// Looks up only the user's own connection, so a caller can never reach a teammate's mailbox.
// The access token lives only in the returned client; it is never stored.
export async function gmailAccessFor(
  client: SupabaseClient,
  workspaceId: string,
  userId: string,
  deps: GmailAccessDependencies = {},
): Promise<GmailAccess> {
  const { data, error } = await client
    .from("connections")
    .select("id, credential_id, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", "gmail")
    .eq("connected_by_user_id", userId)
    .in("status", ["active", "degraded"])
    .limit(1);
  if (error) throw error;
  const connection = ((data ?? []) as Array<{ id: string; credential_id: string | null; status: string }>)[0];
  if (!connection) return { ok: false, code: "google_not_connected", message: NOT_CONNECTED_MESSAGE };

  const settings = (deps.settings ?? googleOAuthSettings)();
  if (!settings) return { ok: false, code: "google_oauth_not_configured", message: "Google sign-in is not set up on this Draft server." };

  const now = deps.now ?? (() => new Date());
  const markDegraded = async () => {
    const { error: updateError } = await client
      .from("connections")
      .update({ status: "degraded", last_error_at: now().toISOString() })
      .eq("id", connection.id);
    if (updateError) throw updateError;
    return { ok: false as const, code: "google_reconnect_required" as const, message: RECONNECT_MESSAGE };
  };

  if (!connection.credential_id) return markDegraded();

  let refreshToken: string;
  try {
    const credential = await resolveProviderCredentialById(workspaceId, "gmail", connection.credential_id, client);
    refreshToken = credential.refresh_token;
  } catch (cause) {
    if (cause instanceof CredentialError) return markDegraded();
    throw cause;
  }

  let accessToken: string;
  try {
    accessToken = (await refreshGoogleAccessToken(settings, refreshToken, deps.fetchImpl ?? fetch)).accessToken;
  } catch (cause) {
    if (cause instanceof GoogleOAuthError && cause.code === "invalid_grant") return markDegraded();
    throw cause;
  }

  if (connection.status === "degraded") {
    const { error: updateError } = await client
      .from("connections")
      .update({ status: "active", last_success_at: now().toISOString() })
      .eq("id", connection.id);
    if (updateError) throw updateError;
  }

  return { ok: true, api: createGmailApi(accessToken, deps.fetchImpl ?? fetch) };
}

/** Providers of the user's own live connections in this workspace. A teammate's connection never counts. */
export async function personalConnectionProviders(client: SupabaseClient, workspaceId: string, userId: string): Promise<Set<string>> {
  const { data, error } = await client
    .from("connections")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .eq("connected_by_user_id", userId)
    .in("status", ["active", "degraded"]);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ provider: string }>).map((row) => row.provider));
}

/**
 * The providers that decide which connection-gated tools a person sees: their own live connections, plus
 * `workspace:<provider>` for each provider anyone in the workspace has live.
 */
export async function toolConnectionProviders(client: SupabaseClient, workspaceId: string, userId: string): Promise<Set<string>> {
  const { data, error } = await client
    .from("connections")
    .select("provider, connected_by_user_id")
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "degraded"]);
  if (error) throw error;
  const providers = new Set<string>();
  for (const row of (data ?? []) as Array<{ provider: string; connected_by_user_id: string | null }>) {
    if (row.connected_by_user_id === userId) providers.add(row.provider);
    providers.add(workspaceProvider(row.provider));
  }
  return providers;
}

/** The same, but a failed lookup gives no providers, so tools that need one stay hidden. */
export async function toolConnectionProvidersOrNone(client: SupabaseClient, workspaceId: string, userId: string, surface: string): Promise<Set<string>> {
  try {
    return await toolConnectionProviders(client, workspaceId, userId);
  } catch (error) {
    console.error(JSON.stringify({ source: surface, event: "personal_connections_lookup_failed", workspaceId, error: error instanceof Error ? error.message : String(error) }));
    return new Set();
  }
}

/** The same, but a failed lookup gives no providers, so tools that need one stay hidden. */
export async function personalConnectionProvidersOrNone(client: SupabaseClient, workspaceId: string, userId: string, surface: string): Promise<Set<string>> {
  try {
    return await personalConnectionProviders(client, workspaceId, userId);
  } catch (error) {
    console.error(JSON.stringify({ source: surface, event: "personal_connections_lookup_failed", workspaceId, error: error instanceof Error ? error.message : String(error) }));
    return new Set();
  }
}
