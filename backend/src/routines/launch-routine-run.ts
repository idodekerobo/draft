import type { SupabaseClient } from "@supabase/supabase-js";
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

export type LaunchRoutineRun = (input: LaunchRoutineRunInput) => Promise<{ machineId: string }>;

export const launchRoutineRun: LaunchRoutineRun = async ({ sessionId, workspaceId, routine, config, client }) => {
  const { data, error } = await client.from("workspaces").select("organization_id").eq("id", workspaceId).single();
  if (error) throw error;
  const organizationId = (data as { organization_id: string }).organization_id;

  const { getWorkspaceContext } = await import("../services/workspace-context");
  const context = await getWorkspaceContext(workspaceId);
  // A workspace with no brain yet still runs; the prompt may not need it.
  const documents = context.ok ? context.snapshot.documents : {};

  const receipt = await launchFlySandboxRun({
    bundle: buildRoutineBundle({ organizationId, workspaceId, sessionId, documents }),
    prompt: renderRoutinePrompt(routine.prompt),
    mode: "routine",
    model: routine.model ?? undefined,
    timeoutSeconds: ROUTINE_RUN_TIMEOUT_SECONDS,
    claudeCodeOAuthToken: await resolveInferenceCredential(workspaceId, client),
    config,
  });
  return { machineId: receipt.machineId };
};
