import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRunSpec } from "draft-core/run-spec";
import { runCaller } from "draft-core/tools";
import { loadVersionDocuments } from "../metaharness/context/context-store";
import { launchWithCredentials } from "../metaharness/sandbox/launch-with-credentials";
export { RoutineLeaseBusyError } from "../metaharness/sandbox/launch-with-credentials";
import { type SandboxDeploymentConfig } from "../metaharness/sandbox";
import { needsDraftToolServer } from "../metaharness/sandbox/run-manifest";
import { buildRoutineBundle, renderRoutinePrompt } from "./build-bundle";
import { ROUTINE_RUN_TIMEOUT_SECONDS, type AgentRoutineConfig } from "./config";
import type { RoutineEventPayload } from "./event";
import { mintRoutineSessionUpload } from "./session-upload";

export interface LaunchRoutineRunInput {
  sessionId: string;
  /** The run this launch carries out. Its base version is the one the bundle is built from. */
  run: AgentRunSpec;
  workspaceId: string;
  routine: AgentRoutineConfig;
  /** How the routine is set to run, in words, so the agent knows its own cadence. */
  setup: { description: string; timezone: string };
  /** True when a person pressed Run now. */
  manual?: boolean;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
  /** What started this run, when events did. Oldest first. */
  events?: RoutineEventPayload[];
}

export type LaunchRoutineRun = (input: LaunchRoutineRunInput) => Promise<{ machineId: string } | void>;

/** The fields the prompt reads. The event's name and provider id stay out of it. */
function toPromptEvent({ description, providerLabel, sourceItemId, facts, title, text, truncated }: RoutineEventPayload) {
  return { description, providerLabel, sourceItemId, facts, title, text, truncated };
}

export const launchRoutineRun: LaunchRoutineRun = async ({ sessionId, run: agentRun, workspaceId, routine, setup, manual, config, client, events }) => {
  const { data, error } = await client.from("workspaces").select("organization_id").eq("id", workspaceId).single();
  if (error) throw error;
  const organizationId = (data as { organization_id: string }).organization_id;

  // The run's own base version, not the latest: the default sha of a write is read from this same version.
  const documents = await loadVersionDocuments(client, agentRun.inputs.contextVersionId);

  const launch = {
    spec: agentRun,
    bundle: buildRoutineBundle({ organizationId, workspaceId, agentRunId: agentRun.id, audience: runCaller(agentRun), documents }),
    prompt: {
      kind: "text" as const,
      text: renderRoutinePrompt(routine.prompt, {
        title: routine.title,
        setup: setup.description,
        timezone: setup.timezone,
        startedAt: new Date(),
        hasDraftTools: needsDraftToolServer(agentRun),
        startedBy: events?.length
          ? { type: "event", events: events.map(toPromptEvent) }
          : { type: manual ? "manual" : "schedule" },
      }),
    },
    timeoutSeconds: ROUTINE_RUN_TIMEOUT_SECONDS,
    config,
    // A run whose links cannot be made still runs. Its session file is just not kept.
    sessionUpload: (await mintRoutineSessionUpload(client, workspaceId, sessionId)) ?? undefined,
  };

  const receipt = await launchWithCredentials(launch, client, sessionId);
  return { machineId: receipt.machineId };
};
