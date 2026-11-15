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

const AGENT_SETUP: Record<"claude" | "codex", { label: string; how: string }> = {
  claude: { label: "Claude Code", how: "Someone in the workspace runs `claude setup-token` and pastes the token under Routines in the Draft app" },
  codex: { label: "Codex", how: "Someone in the workspace connects Codex under Routines in the Draft app" },
};

/**
 * Why a routine on this agent could not run, or null when it can. Both the HTTP routes and Draft's tools refuse with this,
 * so a person or an agent learns what is missing and how to fix it.
 */
export async function routineAgentProblem(client: SupabaseClient, workspaceId: string, harness: string): Promise<{ code: string; message: string } | null> {
  if (harness !== "claude" && harness !== "codex") return null;
  const status = (await routineAgentStatuses(client, workspaceId))[harness];
  if (status === "connected") return null;
  const { label, how } = AGENT_SETUP[harness];
  const problem = status === "needs_reconnect" ? `${label}'s login for routines stopped working` : `${label} isn't connected for routines in this workspace`;
  return {
    code: `${harness}_${status}`,
    message: `${problem}, so a routine on it can't run. ${how}, or pick an agent that routines.options lists as connected.`,
  };
}
