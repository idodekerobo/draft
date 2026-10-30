import type { SupabaseClient } from "@supabase/supabase-js";
import { acquireCodexLease, releaseCodexLease, resolveCodexCredential } from "../credentials/codex-credential";
import { launchFlySandboxRun, type SandboxDeploymentConfig } from "../sandbox";
import { resolveInferenceCredential } from "../synthesis/resolve-credential";
import { buildRoutineBundle, renderRoutinePrompt } from "./build-bundle";
import { ROUTINE_RUN_TIMEOUT_SECONDS, type AgentRoutineConfig } from "./config";

export interface LaunchRoutineRunInput {
  sessionId: string;
  workspaceId: string;
  routine: AgentRoutineConfig;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
}

export type LaunchRoutineRun = (input: LaunchRoutineRunInput) => Promise<void>;

/** Another run holds the workspace's Codex login, and two runs at once would break its refresh token. */
export class RoutineLeaseBusyError extends Error {
  constructor() {
    super("The workspace's Codex login is in use by another run");
    this.name = "RoutineLeaseBusyError";
  }
}

export const launchRoutineRun: LaunchRoutineRun = async ({ sessionId, workspaceId, routine, config, client }) => {
  const { data, error } = await client.from("workspaces").select("organization_id").eq("id", workspaceId).single();
  if (error) throw error;
  const organizationId = (data as { organization_id: string }).organization_id;

  const { getWorkspaceContext } = await import("../services/workspace-context");
  const context = await getWorkspaceContext(workspaceId);
  // A workspace with no brain yet still runs; the prompt may not need it.
  const documents = context.ok ? context.snapshot.documents : {};

  const run = {
    bundle: buildRoutineBundle({ organizationId, workspaceId, sessionId, documents }),
    prompt: renderRoutinePrompt(routine.prompt),
    mode: "routine" as const,
    model: routine.model ?? undefined,
    timeoutSeconds: ROUTINE_RUN_TIMEOUT_SECONDS,
    config,
  };

  if (routine.harness !== "codex") {
    await launchFlySandboxRun({ ...run, claudeCodeOAuthToken: await resolveInferenceCredential(workspaceId, client) });
    return;
  }

  const { credentialId, authJson } = await resolveCodexCredential(client, workspaceId);
  if (!(await acquireCodexLease(client, credentialId, workspaceId, sessionId))) throw new RoutineLeaseBusyError();
  try {
    await launchFlySandboxRun({ ...run, harness: "codex", codexAuthJson: authJson });
  } catch (launchError) {
    await releaseCodexLease(client, credentialId, sessionId).catch(() => undefined);
    throw launchError;
  }
};
