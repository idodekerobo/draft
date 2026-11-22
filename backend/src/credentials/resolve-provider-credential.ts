import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialError, decryptCredentialPayload } from "./crypto";
import type { CredentialSecretRow } from "./harness-credential";
import type { ConnectionProvider, CredentialProvider } from "../types/enums";

export interface FirefliesProviderCredential {
  api_token: string;
  webhook_secret: string;
}

export interface SlackProviderCredential {
  bot_token: string;
  app_token: string;
}

export interface LinearProviderCredential {
  api_token: string;
  webhook_secret: string;
}

export interface GranolaProviderCredential {
  api_token: string;
  webhook_secret: string;
  webhook_endpoint_id: string;
}

export interface GoogleProviderCredential {
  refresh_token: string;
  scopes: string[];
}

// Credentials describe who issued the token, not the product, so Gmail and Google Drive
// connections read one shared "google" credential.
export function credentialProviderFor(provider: ConnectionProvider): CredentialProvider {
  return provider === "gmail" || provider === "google_drive" ? "google" : (provider as CredentialProvider);
}

export type ProviderCredential<P extends ConnectionProvider> = P extends "fireflies"
  ? FirefliesProviderCredential
  : P extends "slack"
    ? SlackProviderCredential
    : P extends "linear"
      ? LinearProviderCredential
      : P extends "granola"
        ? GranolaProviderCredential
        : P extends "gmail" | "google_drive"
          ? GoogleProviderCredential
          : string;

interface ConnectionCredentialRow {
  id: string;
  credential_id: string | null;
  status: string;
}

const NAMED_SECRET_PROVIDERS = new Set<ConnectionProvider>(["fireflies", "slack", "linear", "granola", "gmail", "google_drive"]);

async function resolveCredentialById<P extends ConnectionProvider>(
  workspaceId: string,
  provider: P,
  credentialId: string,
  db: SupabaseClient,
): Promise<ProviderCredential<P>> {
  const { data: credentialData, error: credentialError } = await db
    .from("credentials")
    .select("id, status, expires_at, encrypted_payload, encryption_key_version")
    .eq("id", credentialId)
    .eq("workspace_id", workspaceId)
    .eq("provider", credentialProviderFor(provider))
    .maybeSingle();
  if (credentialError) throw credentialError;

  const credential = credentialData as CredentialSecretRow | null;
  if (!credential) {
    throw new CredentialError(
      `Credential ${credentialId} for workspace ${workspaceId} was not found`,
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

export async function resolveProviderCredentialById<P extends ConnectionProvider>(
  workspaceId: string,
  provider: P,
  credentialId: string,
  client?: SupabaseClient,
): Promise<ProviderCredential<P>> {
  const db = client ?? (await import("../db/client")).serviceClient;
  return resolveCredentialById(workspaceId, provider, credentialId, db);
}

// Assumes one active connection per (workspaceId, provider). Named-secret
// providers store encrypted_payload as a JSON object rather than one string.
export async function resolveProviderCredential<P extends ConnectionProvider>(
  workspaceId: string,
  provider: P,
  client?: SupabaseClient,
): Promise<ProviderCredential<P>> {
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: connectionData, error: connectionError } = await db
    .from("connections")
    .select("id, credential_id, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (connectionError) throw connectionError;

  const connection = connectionData as ConnectionCredentialRow | null;
  if (!connection || !connection.credential_id) {
    throw new CredentialError(
      `Workspace ${workspaceId} has no ${provider} source connection with a credential configured`,
      "missing",
    );
  }
  if (connection.status !== "active" && connection.status !== "degraded") {
    throw new CredentialError(
      `Workspace ${workspaceId} has no ingestible ${provider} source connection`,
      "missing",
    );
  }

  return resolveCredentialById(workspaceId, provider, connection.credential_id, db);
}

export { CredentialError } from "./crypto";
export type { CredentialErrorReason } from "./crypto";
