import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptCredentialPayload } from "../../credentials/crypto";
import { recordRouteError } from "../../errors/route-error";
import { revokeGoogleToken } from "./oauth";

// Runs after a Google connection was disconnected. Revoking ends the whole
// Google grant, so a live connection that shares the credential keeps it.
export async function releaseGoogleCredential(options: {
  client: SupabaseClient;
  workspaceId: string;
  connectionId: string;
  revokeToken?: typeof revokeGoogleToken;
}): Promise<void> {
  const { client, workspaceId, connectionId } = options;
  const revokeToken = options.revokeToken ?? revokeGoogleToken;

  const { data: connection, error: connectionError } = await client
    .from("connections")
    .select("credential_id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<{ credential_id: string | null }>();
  if (connectionError) throw connectionError;
  const credentialId = connection?.credential_id;
  if (!credentialId) return;

  const { data: sharing, error: sharingError } = await client
    .from("connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("credential_id", credentialId)
    .neq("id", connectionId)
    .neq("status", "revoked")
    .limit(1);
  if (sharingError) throw sharingError;
  if (sharing && sharing.length > 0) return;

  try {
    const { data: credential, error } = await client
      .from("credentials")
      .select("encrypted_payload, encryption_key_version")
      .eq("id", credentialId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (credential) {
      const payload = JSON.parse(
        decryptCredentialPayload(credential.encrypted_payload, credential.encryption_key_version as string),
      ) as { refresh_token?: string };
      if (payload.refresh_token) await revokeToken(payload.refresh_token);
    }
  } catch (error) {
    recordRouteError({ workspaceId, connectionId, operation: "auth", errorCode: "google_token_revoke_failed", error });
  }

  const { error: revokeError } = await client
    .from("credentials")
    .update({ status: "revoked" })
    .eq("id", credentialId)
    .eq("workspace_id", workspaceId);
  if (revokeError) throw revokeError;
}
