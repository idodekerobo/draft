import { recordError } from "../../errors/record-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CODEX_CREDENTIAL_PROVIDER, acquireCodexLease, releaseCodexLease, resolveCodexCredential, saveRefreshedCodexLogin } from "../../credentials/codex-credential";
import { resolveInferenceCredential } from "../../synthesis/resolve-credential";
import { launchSandboxRun, type LaunchSandboxRunInput } from "./launch";

export class RoutineLeaseBusyError extends Error {
  constructor() {
    super("The workspace's Codex login is in use by another run");
    this.name = "RoutineLeaseBusyError";
  }
}

export async function reserveCodexRunLogin(client: SupabaseClient, workspaceId: string, leaseId: string) {
  const login = await resolveCodexCredential(client, workspaceId);
  if (!(await acquireCodexLease(client, login.credentialId, workspaceId, leaseId))) throw new RoutineLeaseBusyError();
  return login;
}

export async function launchWithCredentials(input: Omit<LaunchSandboxRunInput, "credentials">, client: SupabaseClient, leaseId: string = input.spec.id) {
  const { spec } = input;
  if (spec.harness === "claude") {
    return launchSandboxRun({ ...input, credentials: { claudeCodeOAuthToken: await resolveInferenceCredential(spec.workspaceId, client) } });
  }
  const { credentialId, authJson } = await reserveCodexRunLogin(client, spec.workspaceId, leaseId);
  try {
    return await launchSandboxRun({ ...input, credentials: { codexAuthJson: authJson } });
  } catch (error) {
    await releaseCodexLease(client, credentialId, leaseId).catch((releaseError) =>
      recordError({ client, workspaceId: spec.workspaceId, agentRunId: spec.id, operation: "scheduling", code: "codex_lease_release_failed", message: "Releasing the Codex login after a failed launch failed", error: releaseError }),
    );
    throw error;
  }
}

export async function completeRunCredentials(client: SupabaseClient, runId: string, authJson: unknown): Promise<void> {
  const { data: run, error } = await client.from("agent_runs").select("harness, workspace_id").eq("id", runId).maybeSingle();
  if (error) throw error;
  if (run?.harness !== "codex") return;
  const { data: credential, error: credentialError } = await client.from("credentials").select("id")
    .eq("workspace_id", run.workspace_id).eq("provider", CODEX_CREDENTIAL_PROVIDER).eq("lease_run_id", runId).maybeSingle();
  if (credentialError) throw credentialError;
  if (!credential) return;
  await saveRefreshedCodexLogin(client, run.workspace_id, authJson);
  await releaseCodexLease(client, credential.id, runId);
}
