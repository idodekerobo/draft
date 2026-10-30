import type { SupabaseClient } from "@supabase/supabase-js";
import { codexCredentialStatus } from "../credentials/codex-credential";

/** Whether a workspace's routines can run on an agent. A login that stopped working needs a new sign-in. */
export type RoutineAgentStatus = "connected" | "not_connected" | "needs_reconnect";

const fromCredential = (status: string | null): RoutineAgentStatus =>
  status === null ? "not_connected" : status === "active" ? "connected" : "needs_reconnect";

async function claudeCredentialStatus(client: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data: workspace, error } = await client.from("workspaces").select("inference_credential_id").eq("id", workspaceId).single();
  if (error) throw error;
  const credentialId = (workspace as { inference_credential_id: string | null } | null)?.inference_credential_id ?? null;
  if (!credentialId) return null;
  const { data, error: credentialError } = await client.from("credentials").select("status").eq("id", credentialId).eq("workspace_id", workspaceId).maybeSingle();
  if (credentialError) throw credentialError;
  return (data as { status: string } | null)?.status ?? null;
}

/** The status of each agent a routine can use, by harness id. */
export async function routineAgentStatuses(client: SupabaseClient, workspaceId: string): Promise<Record<"claude" | "codex", RoutineAgentStatus>> {
  const [claude, codex] = await Promise.all([claudeCredentialStatus(client, workspaceId), codexCredentialStatus(client, workspaceId)]);
  return { claude: fromCredential(claude), codex: fromCredential(codex) };
}

/** True when a routine on this harness could not run for want of a login. Only Codex is held to it when a routine is saved. */
export async function lacksRoutineLogin(client: SupabaseClient, workspaceId: string, harness: string): Promise<boolean> {
  return harness === "codex" && (await codexCredentialStatus(client, workspaceId)) !== "active";
}
