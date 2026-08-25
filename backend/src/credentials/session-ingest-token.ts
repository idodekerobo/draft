import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CURRENT_CREDENTIAL_KEY_VERSION,
  decryptCredentialPayload,
  encryptCredentialPayload,
} from "./crypto";

const TOKEN_PREFIX = "draft_sit_";

// Rotate/disable pull expires_at in to now + this window instead of hard
// revoking, so the existing expiry check gives grace-then-block for free.
export const ROTATION_GRACE_WINDOW_MS = 10 * 60 * 1000;

const LEGACY_PROVIDER = "claude_session_ingest";
const SCOPED_PROVIDER = "agent_session_ingest";

interface IngestCredentialRow {
  id: string;
  workspace_id: string;
  provider: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
  session_project_id: string | null;
  allowed_providers: string[] | null;
}

export interface IngestCredentialScope {
  credentialId: string;
  workspaceId: string;
  // Null on a legacy credential -- callers must branch on this, never
  // reject or coerce it.
  sessionProjectId: string | null;
  allowedProviders: string[] | null;
}

export interface MintScopedTokenInput {
  workspaceId: string;
  label: string | null;
  sessionProjectId: string;
  allowedProviders: string[];
}

async function mint(
  client: SupabaseClient,
  row: {
    workspace_id: string;
    provider: string;
    label: string | null;
    session_project_id: string | null;
    allowed_providers: string[] | null;
  },
): Promise<{ id: string; token: string }> {
  const secret = randomBytes(32).toString("base64url");
  const encrypted = encryptCredentialPayload(secret, CURRENT_CREDENTIAL_KEY_VERSION);

  const { data, error } = await client
    .from("credentials")
    .insert({
      ...row,
      encrypted_payload: encrypted,
      encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to mint session ingest token");

  return { id: data.id as string, token: `${TOKEN_PREFIX}${data.id}_${secret}` };
}

// Only mint path new code should use -- legacy claude_session_ingest
// credentials are never minted going forward.
export async function mintSessionIngestToken(
  client: SupabaseClient,
  input: MintScopedTokenInput,
): Promise<{ id: string; token: string }> {
  return mint(client, {
    workspace_id: input.workspaceId,
    provider: SCOPED_PROVIDER,
    label: input.label,
    session_project_id: input.sessionProjectId,
    allowed_providers: input.allowedProviders,
  });
}

async function fetchActiveCredentialRow(
  client: SupabaseClient,
  credentialId: string,
): Promise<IngestCredentialRow | null> {
  const { data, error } = await client
    .from("credentials")
    .select(
      "id, workspace_id, provider, status, expires_at, encrypted_payload, encryption_key_version, session_project_id, allowed_providers",
    )
    .eq("id", credentialId)
    .in("provider", [LEGACY_PROVIDER, SCOPED_PROVIDER])
    .maybeSingle<IngestCredentialRow>();
  if (error || !data) return null;
  return data;
}

function parseToken(token: string): { credentialId: string; presentedSecret: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const separatorIndex = rest.indexOf("_");
  if (separatorIndex === -1) return null;

  const credentialId = rest.slice(0, separatorIndex);
  const presentedSecret = rest.slice(separatorIndex + 1);
  if (!credentialId || !presentedSecret) return null;
  return { credentialId, presentedSecret };
}

// Every rejection path (wrong id, wrong secret, wrong length, inactive,
// expired, decrypt failure) returns the same uniform false/null rather
// than leaking timing/length information.
async function verifyPresentedSecret(
  row: IngestCredentialRow,
  presentedSecret: string,
): Promise<boolean> {
  if (row.status !== "active") return false;
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) return false;

  let expectedSecret: string;
  try {
    expectedSecret = decryptCredentialPayload(row.encrypted_payload, row.encryption_key_version);
  } catch {
    return false;
  }

  const presentedBuffer = Buffer.from(presentedSecret, "utf8");
  const expectedBuffer = Buffer.from(expectedSecret, "utf8");
  if (presentedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(presentedBuffer, expectedBuffer);
}

export async function resolveIngestCredentialScope(
  client: SupabaseClient,
  token: string,
): Promise<IngestCredentialScope | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const row = await fetchActiveCredentialRow(client, parsed.credentialId);
  if (!row) return null;

  const ok = await verifyPresentedSecret(row, parsed.presentedSecret);
  if (!ok) return null;

  await client
    .from("credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id);

  return {
    credentialId: row.id,
    workspaceId: row.workspace_id,
    sessionProjectId: row.session_project_id,
    allowedProviders: row.allowed_providers,
  };
}

export interface RotateResult {
  id: string;
  token: string;
}

// Credential-gated, not Draft user auth -- verifies the presented token the
// same way /sessions/ingest does, mints a new one with identical scope,
// then grace-windows the old one.
export async function rotateSessionIngestToken(
  client: SupabaseClient,
  presentedToken: string,
): Promise<RotateResult | null> {
  const scope = await resolveIngestCredentialScope(client, presentedToken);
  if (!scope) return null;

  const minted = await mint(client, {
    workspace_id: scope.workspaceId,
    provider: scope.sessionProjectId ? SCOPED_PROVIDER : LEGACY_PROVIDER,
    label: null,
    session_project_id: scope.sessionProjectId,
    allowed_providers: scope.allowedProviders,
  });

  await client
    .from("credentials")
    .update({ expires_at: new Date(Date.now() + ROTATION_GRACE_WINDOW_MS).toISOString() })
    .eq("id", scope.credentialId);

  return minted;
}

// Same grace-window mechanism as rotate, just no replacement minted --
// disable shouldn't instantly stop the rest of the team mid-session.
export async function revokeSessionIngestTokenWithGrace(
  client: SupabaseClient,
  presentedToken: string,
): Promise<boolean> {
  const scope = await resolveIngestCredentialScope(client, presentedToken);
  if (!scope) return false;

  await client
    .from("credentials")
    .update({ expires_at: new Date(Date.now() + ROTATION_GRACE_WINDOW_MS).toISOString() })
    .eq("id", scope.credentialId);

  return true;
}

// Hard revoke by credential id -- for a leaked credential recovered from
// git history. Caller must enforce workspace membership (withAuth +
// assertWorkspaceAccess); possession of the credential itself isn't checked.
export async function adminRevokeCredential(
  client: SupabaseClient,
  workspaceId: string,
  credentialId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("credentials")
    .update({ status: "revoked" })
    .eq("id", credentialId)
    .eq("workspace_id", workspaceId)
    .in("provider", [LEGACY_PROVIDER, SCOPED_PROVIDER])
    .select("id")
    .maybeSingle();
  return !error && !!data;
}
