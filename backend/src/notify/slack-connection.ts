import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredentialById } from "../credentials/resolve-provider-credential";

export async function workspaceSlackCredentialId(client: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await client.from("connections").select("credential_id")
    .eq("workspace_id", workspaceId).eq("provider", "slack").eq("status", "active").maybeSingle();
  if (error) throw error;
  return (data as { credential_id: string | null } | null)?.credential_id ?? null;
}

export async function resolveWorkspaceSlackBotToken(client: SupabaseClient, workspaceId: string, credentialId?: string): Promise<string> {
  const id = credentialId ?? await workspaceSlackCredentialId(client, workspaceId);
  if (!id) throw new Error("Slack is not connected for this workspace.");
  return (await resolveProviderCredentialById(workspaceId, "slack", id, client)).bot_token;
}
