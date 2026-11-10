import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialError } from "../credentials/crypto";
import { secretFromRow } from "../credentials/harness-credential";
import type { CredentialErrorReason } from "../credentials/crypto";

export { encryptCredentialPayload } from "../credentials/crypto";

// Aliased so existing imports of this name keep working.
export type InferenceCredentialErrorReason = CredentialErrorReason;
export const InferenceCredentialError = CredentialError;
export type InferenceCredentialError = CredentialError;

interface CredentialSecretRow {
  id: string;
  workspace_id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

// Always reads via the service-role client — credentials has RLS enabled
// with zero policies (db/schemas/credentials.sql), so only the service role
// can select encrypted_payload.
export async function resolveInferenceCredential(
  workspaceId: string,
  client?: SupabaseClient,
): Promise<string> {
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: workspace, error: workspaceError } = await db
    .from("workspaces")
    .select("inference_credential_id")
    .eq("id", workspaceId)
    .single();
  if (workspaceError) throw workspaceError;

  const credentialId = (workspace as { inference_credential_id: string | null })
    .inference_credential_id;
  if (!credentialId) {
    throw new CredentialError(
      `Workspace ${workspaceId} has no inference_credential_id configured`,
      "missing",
    );
  }

  const { data: credential, error: credentialError } = await db
    .from("credentials")
    .select(
      "id, workspace_id, status, expires_at, encrypted_payload, encryption_key_version",
    )
    .eq("id", credentialId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (credentialError) throw credentialError;

  const row = credential as CredentialSecretRow | null;
  if (!row) {
    throw new CredentialError(
      `Credential ${credentialId} for workspace ${workspaceId} was not found`,
      "missing",
    );
  }

  return secretFromRow(row, "Credential");
}
