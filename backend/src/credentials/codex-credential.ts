import type { SupabaseClient } from "@supabase/supabase-js";
import { CURRENT_CREDENTIAL_KEY_VERSION, CredentialError, decryptCredentialPayload, encryptCredentialPayload } from "./crypto";

export const CODEX_CREDENTIAL_PROVIDER = "codex_chatgpt_auth";

const AUTH_JSON_MAX_BYTES = 64 * 1024;
const LEASE_TTL = "20 minutes";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * The text of a Codex `auth.json` that can run a routine, or null. A ChatGPT login needs a refresh token,
 * because Codex renews the login by itself. An API key works too, so a workspace can use one instead.
 */
export function parseCodexAuthJson(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > AUTH_JSON_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.auth_mode === "chatgpt") return isObject(parsed.tokens) && isText(parsed.tokens.refresh_token) ? value : null;
  if (parsed.auth_mode === "apikey") return isText(parsed.OPENAI_API_KEY) ? value : null;
  return null;
}

/** Whether Codex changed the login during a run. A refresh moves `last_refresh`, and the old refresh token stops working. */
export function authJsonChanged(before: string, after: string): boolean {
  try {
    const [a, b] = [JSON.parse(before), JSON.parse(after)] as Array<Record<string, unknown>>;
    return a.last_refresh !== b.last_refresh || JSON.stringify(a.tokens) !== JSON.stringify(b.tokens);
  } catch {
    return false;
  }
}

interface CredentialRow {
  id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

async function loadRow(client: SupabaseClient, workspaceId: string): Promise<CredentialRow | null> {
  const { data, error } = await client
    .from("credentials")
    .select("id, status, expires_at, encrypted_payload, encryption_key_version")
    .eq("workspace_id", workspaceId)
    .eq("provider", CODEX_CREDENTIAL_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  return data as CredentialRow | null;
}

/** The status of the workspace's Codex login for routines, or null when it has none. */
export async function codexCredentialStatus(client: SupabaseClient, workspaceId: string): Promise<string | null> {
  return (await loadRow(client, workspaceId))?.status ?? null;
}

/** Saves a new login for the workspace, replacing an earlier one. Returns the credential id. */
export async function saveCodexCredential(client: SupabaseClient, workspaceId: string, authJson: string, userId: string): Promise<string> {
  const encrypted = encryptCredentialPayload(authJson, CURRENT_CREDENTIAL_KEY_VERSION);
  const existing = await loadRow(client, workspaceId);
  if (existing) {
    const { error } = await client
      .from("credentials")
      .update({ encrypted_payload: encrypted, encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION, status: "active", lease_run_id: null, lease_expires_at: null })
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId);
    if (error) throw error;
    return existing.id;
  }
  const { data, error } = await client
    .from("credentials")
    .insert({ workspace_id: workspaceId, provider: CODEX_CREDENTIAL_PROVIDER, encrypted_payload: encrypted, encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION, status: "active", created_by_user_id: userId })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("credential insert returned no row");
  return (data as { id: string }).id;
}

/** Reads the workspace's login. Throws a `CredentialError` when it is missing, revoked or expired. */
export async function resolveCodexCredential(client: SupabaseClient, workspaceId: string): Promise<{ credentialId: string; authJson: string }> {
  const row = await loadRow(client, workspaceId);
  if (!row) throw new CredentialError(`Workspace ${workspaceId} has no Codex login`, "missing");
  if (row.status === "revoked") throw new CredentialError(`Codex login ${row.id} has been revoked`, "revoked");
  if (row.status === "expired" || (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new CredentialError(`Codex login ${row.id} has expired`, "expired");
  }
  if (row.status !== "active") throw new CredentialError(`Codex login ${row.id} has status "${row.status}"`, "missing");
  return { credentialId: row.id, authJson: decryptCredentialPayload(row.encrypted_payload, row.encryption_key_version) };
}

/** Writes back a login that Codex refreshed during a run. */
export async function updateCodexCredential(client: SupabaseClient, credentialId: string, authJson: string): Promise<void> {
  const { error } = await client
    .from("credentials")
    .update({ encrypted_payload: encryptCredentialPayload(authJson, CURRENT_CREDENTIAL_KEY_VERSION), encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION })
    .eq("id", credentialId);
  if (error) throw error;
}

/** True when this run now holds the login's lease. False when another run holds it. */
export async function acquireCodexLease(client: SupabaseClient, credentialId: string, workspaceId: string, runId: string): Promise<boolean> {
  const { data, error } = await client.rpc("acquire_credential_lease", { p_credential_id: credentialId, p_workspace_id: workspaceId, p_run_id: runId, p_ttl: LEASE_TTL });
  if (error) throw error;
  return data === true;
}

export async function releaseCodexLease(client: SupabaseClient, credentialId: string, runId: string): Promise<void> {
  const { error } = await client.rpc("release_credential_lease", { p_credential_id: credentialId, p_run_id: runId });
  if (error) throw error;
}
