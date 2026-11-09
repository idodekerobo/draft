import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRunSpec } from "draft-core/agent-run";
import { loadVersionDocuments } from "../agent-runs/context-store";
import { acquireCodexLease, releaseCodexLease, resolveCodexCredential } from "../credentials/codex-credential";
import { launchFlySandboxRun, type SandboxDeploymentConfig } from "../sandbox";
import { resolveInferenceCredential } from "../synthesis/resolve-credential";
import { buildRoutineBundle, renderRoutinePrompt } from "./build-bundle";
import { ROUTINE_RUN_TIMEOUT_SECONDS, type AgentRoutineConfig } from "./config";

export interface LaunchRoutineRunInput {
  sessionId: string;
  /** The run this launch carries out. Its base version is the one the bundle is built from. */
  run: AgentRunSpec;
  workspaceId: string;
  routine: AgentRoutineConfig;
  /** When the routine runs, so the agent can know its own cadence. */
  schedule: { description: string; timezone: string };
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
}

export type LaunchRoutineRun = (input: LaunchRoutineRunInput) => Promise<{ machineId: string } | void>;

/** Another run holds the workspace's Codex login, and two runs at once would break its refresh token. */
export class RoutineLeaseBusyError extends Error {
  constructor() {
    super("The workspace's Codex login is in use by another run");
    this.name = "RoutineLeaseBusyError";
  }
}

export const launchRoutineRun: LaunchRoutineRun = async ({ sessionId, run: agentRun, workspaceId, routine, schedule, config, client }) => {
  const { data, error } = await client.from("workspaces").select("organization_id").eq("id", workspaceId).single();
  if (error) throw error;
  const organizationId = (data as { organization_id: string }).organization_id;

  // The run's own base version, not the latest: the default sha of a write is read from this same version.
  const documents = await loadVersionDocuments(client, agentRun.inputs.contextVersionId);

  const run = {
    bundle: buildRoutineBundle({ organizationId, workspaceId, sessionId, audience: { type: "run", run: agentRun }, documents }),
    prompt: renderRoutinePrompt(routine.prompt, {
      title: routine.title,
      schedule: schedule.description,
      timezone: schedule.timezone,
      startedAt: new Date(),
      hasDraftTools: agentRun.permissions.length > 0,
    }),
    mode: "routine" as const,
    model: routine.model ?? undefined,
    timeoutSeconds: ROUTINE_RUN_TIMEOUT_SECONDS,
    agentRun: { id: agentRun.id, workspaceId: agentRun.workspaceId },
    nativeTools: agentRun.runtime.type === "cloud" ? agentRun.runtime.environment.nativeTools.map((permission) => permission.tool) : undefined,
    config,
  };

  if (routine.harness !== "codex") {
    const receipt = await launchFlySandboxRun({ ...run, claudeCodeOAuthToken: await resolveInferenceCredential(workspaceId, client) });
    return { machineId: receipt.machineId };
  }

  const { credentialId, authJson } = await resolveCodexCredential(client, workspaceId);
  if (!(await acquireCodexLease(client, credentialId, workspaceId, sessionId))) throw new RoutineLeaseBusyError();
  try {
    const receipt = await launchFlySandboxRun({ ...run, harness: "codex", codexAuthJson: authJson });
    return { machineId: receipt.machineId };
  } catch (launchError) {
    await releaseCodexLease(client, credentialId, sessionId).catch(() => undefined);
    throw launchError;
  }
};
