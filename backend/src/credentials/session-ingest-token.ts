import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CURRENT_CREDENTIAL_KEY_VERSION,
  decryptCredentialPayload,
  encryptCredentialPayload,
} from "./crypto";

const TOKEN_PREFIX = "draft_sit_";

interface IngestCredentialRow {
  id: string;
  workspace_id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

export async function mintSessionIngestToken(
  client: SupabaseClient,
  workspaceId: string,
  label: string | null,
): Promise<{ id: string; token: string }> {
  const secret = randomBytes(32).toString("base64url");
  const encrypted = encryptCredentialPayload(secret, CURRENT_CREDENTIAL_KEY_VERSION);

  const { data, error } = await client
    .from("credentials")
    .insert({
      workspace_id: workspaceId,
      provider: "claude_session_ingest",
      label,
      encrypted_payload: encrypted,
      encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to mint session ingest token");

  return { id: data.id as string, token: `${TOKEN_PREFIX}${data.id}_${secret}` };
}

/**
 * Never throws — a malformed/short/tampered token is just another failure
 * to reject uniformly, not an exceptional condition.
 */
export async function resolveWorkspaceFromIngestToken(
  client: SupabaseClient,
  token: string,
): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const separatorIndex = rest.indexOf("_");
  if (separatorIndex === -1) return null;

  const credentialId = rest.slice(0, separatorIndex);
  const presentedSecret = rest.slice(separatorIndex + 1);
  if (!credentialId || !presentedSecret) return null;

  const { data, error } = await client
    .from("credentials")
    .select("id, workspace_id, status, expires_at, encrypted_payload, encryption_key_version")
    .eq("id", credentialId)
    .eq("provider", "claude_session_ingest")
    .maybeSingle<IngestCredentialRow>();
  if (error || !data) return null;

  if (data.status !== "active") return null;
  if (data.expires_at !== null && new Date(data.expires_at).getTime() <= Date.now()) return null;

  let expectedSecret: string;
  try {
    expectedSecret = decryptCredentialPayload(data.encrypted_payload, data.encryption_key_version);
  } catch {
    return null;
  }

  // timingSafeEqual throws on unequal-length buffers -- length-guard first
  // so every rejection path (wrong id, wrong secret, wrong length,
  // inactive, expired, decrypt failure) returns the same uniform failure
  // rather than one leaking length information via an unhandled exception.
  const presentedBuffer = Buffer.from(presentedSecret, "utf8");
  const expectedBuffer = Buffer.from(expectedSecret, "utf8");
  if (presentedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(presentedBuffer, expectedBuffer)) return null;

  await client
    .from("credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", credentialId);

  return data.workspace_id;
}
