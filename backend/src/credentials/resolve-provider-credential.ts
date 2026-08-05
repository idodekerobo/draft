import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialError, decryptCredentialPayload } from "./crypto";
import type { SourceConnectionProvider } from "../types/enums";

export interface FirefliesProviderCredential {
  api_token: string;
  webhook_secret: string;
}

export interface SlackProviderCredential {
  bot_token: string;
  app_token: string;
}

export type ProviderCredential<P extends SourceConnectionProvider> = P extends "fireflies"
  ? FirefliesProviderCredential
  : P extends "slack"
    ? SlackProviderCredential
    : string;

interface SourceConnectionCredentialRow {
  id: string;
  credential_id: string | null;
}

interface CredentialSecretRow {
  id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

const NAMED_SECRET_PROVIDERS = new Set<SourceConnectionProvider>(["fireflies", "slack"]);

// Assumes one active source_connection per (workspaceId, provider). Fireflies
// and Slack need more than one named secret per connection, so for those
// providers encrypted_payload holds a JSON object rather than one string.
export async function resolveProviderCredential<P extends SourceConnectionProvider>(
  workspaceId: string,
  provider: P,
  client?: SupabaseClient,
): Promise<ProviderCredential<P>> {
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: connectionData, error: connectionError } = await db
    .from("source_connections")
    .select("id, credential_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (connectionError) throw connectionError;

  const connection = connectionData as SourceConnectionCredentialRow | null;
  if (!connection || !connection.credential_id) {
    throw new CredentialError(
      `Workspace ${workspaceId} has no ${provider} source connection with a credential configured`,
      "missing",
    );
  }

  const { data: credentialData, error: credentialError } = await db
    .from("credentials")
    .select("id, status, expires_at, encrypted_payload, encryption_key_version")
    .eq("id", connection.credential_id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (credentialError) throw credentialError;

  const credential = credentialData as CredentialSecretRow | null;
  if (!credential) {
    throw new CredentialError(
      `Credential ${connection.credential_id} for workspace ${workspaceId} was not found`,
      "missing",
    );
  }

  if (credential.status === "revoked") {
    throw new CredentialError(`Credential ${credential.id} has been revoked`, "revoked");
  }

  const isExpiredByTimestamp =
    credential.expires_at !== null &&
    new Date(credential.expires_at).getTime() <= Date.now();
  if (credential.status === "expired" || isExpiredByTimestamp) {
    throw new CredentialError(`Credential ${credential.id} has expired`, "expired");
  }

  if (credential.status !== "active") {
    throw new CredentialError(
      `Credential ${credential.id} has unexpected status "${credential.status}"`,
      "missing",
    );
  }

  const plaintext = decryptCredentialPayload(
    credential.encrypted_payload,
    credential.encryption_key_version,
  );

  if (!NAMED_SECRET_PROVIDERS.has(provider)) {
    return plaintext as ProviderCredential<P>;
  }

  try {
    return JSON.parse(plaintext) as ProviderCredential<P>;
  } catch (cause) {
    throw new CredentialError(
      `Credential ${credential.id} for provider "${provider}" did not decrypt to valid JSON`,
      "decrypt_failed",
    );
  }
}

export { CredentialError } from "./crypto";
export type { CredentialErrorReason } from "./crypto";
