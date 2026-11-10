import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialRules } from "draft-core/harnesses/types";
import { CURRENT_CREDENTIAL_KEY_VERSION, CredentialError, decryptCredentialPayload, encryptCredentialPayload } from "./crypto";

/** The columns of a credentials row that the status check and the decrypt need. */
export interface CredentialSecretRow {
  id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

const SECRET_COLUMNS = "id, status, expires_at, encrypted_payload, encryption_key_version";

/** The secret of a credentials row. Throws a `CredentialError` when the row is revoked, expired or not active. */
export function secretFromRow(row: CredentialSecretRow, name: string): string {
  if (row.status === "revoked") throw new CredentialError(`${name} ${row.id} has been revoked`, "revoked");
  if (row.status === "expired" || (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new CredentialError(`${name} ${row.id} has expired`, "expired");
  }
  if (row.status !== "active") throw new CredentialError(`${name} ${row.id} has unexpected status "${row.status}"`, "missing");
  return decryptCredentialPayload(row.encrypted_payload, row.encryption_key_version);
}

async function loadRow(client: SupabaseClient, workspaceId: string, rules: CredentialRules): Promise<CredentialSecretRow | null> {
  const { data, error } = await client.from("credentials").select(SECRET_COLUMNS).eq("workspace_id", workspaceId).eq("provider", rules.provider).maybeSingle();
  if (error) throw error;
  return data as CredentialSecretRow | null;
}

/** The status of the workspace's login for this harness, or null when it has none. */
export async function credentialStatus(client: SupabaseClient, workspaceId: string, rules: CredentialRules): Promise<string | null> {
  return (await loadRow(client, workspaceId, rules))?.status ?? null;
}

/** Saves a new login for the workspace, replacing an earlier one. Returns the credential id. */
export async function saveCredential(client: SupabaseClient, workspaceId: string, rules: CredentialRules, secret: string, userId: string): Promise<string> {
  const encrypted = encryptCredentialPayload(secret, CURRENT_CREDENTIAL_KEY_VERSION);
  const existing = await loadRow(client, workspaceId, rules);
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
    .insert({ workspace_id: workspaceId, provider: rules.provider, encrypted_payload: encrypted, encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION, status: "active", created_by_user_id: userId })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("credential insert returned no row");
  return (data as { id: string }).id;
}

/** Reads the workspace's login. Throws a `CredentialError` when it is missing, revoked or expired. */
export async function resolveCredential(client: SupabaseClient, workspaceId: string, rules: CredentialRules): Promise<{ credentialId: string; secret: string }> {
  const row = await loadRow(client, workspaceId, rules);
  if (!row) throw new CredentialError(`Workspace ${workspaceId} has no ${rules.label}`, "missing");
  return { credentialId: row.id, secret: secretFromRow(row, rules.label) };
}

/** Keeps the login a run sent back when the harness refreshed it. A file that is unreadable or unchanged is ignored. */
export async function saveRefreshed(client: SupabaseClient, workspaceId: string, rules: CredentialRules, sentBack: unknown): Promise<boolean> {
  const secret = rules.validate(sentBack);
  if (!secret) return false;
  const current = await resolveCredential(client, workspaceId, rules);
  if (!rules.changedDuringRun(current.secret, secret)) return false;
  await updateCredentialSecret(client, current.credentialId, secret);
  return true;
}

/** Writes back a login that the harness refreshed during a run. */
export async function updateCredentialSecret(client: SupabaseClient, credentialId: string, secret: string): Promise<void> {
  const { error } = await client
    .from("credentials")
    .update({ encrypted_payload: encryptCredentialPayload(secret, CURRENT_CREDENTIAL_KEY_VERSION), encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION })
    .eq("id", credentialId);
  if (error) throw error;
}

function leaseTtl(rules: CredentialRules): string {
  if (!rules.lease) throw new Error(`The ${rules.label} has no lease`);
  return rules.lease.ttl;
}

/** True when this run now holds the login's lease. False when another run holds it. */
export async function acquireLease(client: SupabaseClient, rules: CredentialRules, credentialId: string, workspaceId: string, runId: string): Promise<boolean> {
  const { data, error } = await client.rpc("acquire_credential_lease", { p_credential_id: credentialId, p_workspace_id: workspaceId, p_run_id: runId, p_ttl: leaseTtl(rules) });
  if (error) throw error;
  return data === true;
}

export async function releaseLease(client: SupabaseClient, credentialId: string, runId: string): Promise<void> {
  const { error } = await client.rpc("release_credential_lease", { p_credential_id: credentialId, p_run_id: runId });
  if (error) throw error;
}

/** Ends this run's lease on the workspace's login. Does nothing when the workspace has no login or the run does not hold the lease. */
export async function releaseLeaseForRun(client: SupabaseClient, workspaceId: string, rules: CredentialRules, runId: string): Promise<void> {
  const row = await loadRow(client, workspaceId, rules);
  if (row) await releaseLease(client, row.id, runId);
}
