import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredentialById } from "../credentials/resolve-provider-credential";
import { recordRouteError } from "../errors/route-error";
import { stopSlackListener } from "../ingestion/slack/bootstrap";
import { deleteGranolaWebhookEndpoint } from "../ingestion/granola/webhook-endpoints";
import type { ConnectionProvider } from "../types/enums";

export type DisconnectOutcome = "disconnected" | "not_found" | "not_owner";
export type DisconnectResult = { ok: true; outcome: DisconnectOutcome } | { ok: false; error: unknown };

/**
 * Disconnects the caller's connection to a provider and stops what runs for it. The RPC decides ownership
 * and reports which case happened, so no separate lookup is needed.
 */
export async function disconnectConnection(
  client: SupabaseClient,
  input: { workspaceId: string; userId: string; provider: ConnectionProvider; accountKind: "personal" | "workspace" | null },
): Promise<DisconnectResult> {
  const { data, error } = await client.rpc("disconnect_connection", {
    p_workspace_id: input.workspaceId,
    p_provider: input.provider,
    p_connected_by_user_id: input.userId,
    p_account_kind: input.accountKind,
  });
  if (error) return { ok: false, error };

  const result = (Array.isArray(data) ? data[0] : data) as { connection_id: string | null; outcome: DisconnectOutcome } | null;
  const outcome = result?.outcome ?? "not_found";
  if (outcome !== "disconnected" || !result?.connection_id) return { ok: true, outcome };

  if (input.provider === "slack") await stopSlackListener(result.connection_id);
  if (input.provider === "granola") await deleteGranolaWebhookBestEffort(client, input.workspaceId, result.connection_id);
  return { ok: true, outcome };
}

/** Avoids the 4-day window before Granola auto-disables and emails about a dead endpoint. A failure here is not fatal. */
async function deleteGranolaWebhookBestEffort(client: SupabaseClient, workspaceId: string, connectionId: string): Promise<void> {
  const { data: revokedConnection } = await client
    .from("connections")
    .select("credential_id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<{ credential_id: string | null }>();
  if (!revokedConnection?.credential_id) return;
  try {
    const credential = await resolveProviderCredentialById(workspaceId, "granola", revokedConnection.credential_id, client);
    await deleteGranolaWebhookEndpoint(credential.api_token, credential.webhook_endpoint_id);
  } catch (cleanupError) {
    recordRouteError({ workspaceId, connectionId, operation: "auth", errorCode: "granola_webhook_cleanup_failed", error: cleanupError });
  }
}
