import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import type { RoutineStep } from "draft-core/routine-steps";
import { specFromRow } from "../metaharness/runs/agent-run-store";
import { markAgentRunRunning } from "../metaharness/runs/lifecycle";
import { launchWithCredentials, RoutineLeaseBusyError } from "../metaharness/sandbox/launch-with-credentials";
import type { AgentRunRow } from "../types/tables";
import { failStepRun } from "./step-failure";
import type { EngineDeps, ParentRun, StepOutputs } from "./types";

export type LaunchOutcome = "launched" | "lost_claim" | "lease_busy" | "failed";

export const isActiveRun = (run: Pick<AgentRunRow, "status">): boolean =>
  (ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(run.status) && run.status !== "queued";

/** The workspace's current context version, so a step that waited in the queue starts from what its predecessors wrote. */
async function currentContextVersionId(client: EngineDeps["client"], workspaceId: string): Promise<string | null> {
  const { data, error } = await client.from("workspaces").select("current_context_version_id").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  return (data as { current_context_version_id: string | null } | null)?.current_context_version_id ?? null;
}

/**
 * Starts one queued step run. A guarded update claims it, so two callers cannot start the same run. A run that
 * waited is moved to the newest context version first, so its `baseSha` checks match what the earlier steps wrote.
 */
export async function launchStepRun(deps: EngineDeps, parent: ParentRun, step: RoutineStep, run: AgentRunRow, outputs: StepOutputs): Promise<LaunchOutcome> {
  const { client } = deps;
  const { data, error } = await client.from("agent_runs").update({ status: "preparing" }).eq("id", run.id).eq("status", "queued").select("*");
  if (error) throw error;
  const claimed = ((data ?? []) as AgentRunRow[])[0];
  if (!claimed) return "lost_claim";

  try {
    const versionId = await currentContextVersionId(client, claimed.workspace_id);
    if (versionId && versionId !== claimed.base_context_version_id) {
      const { error: rebaseError } = await client.from("agent_runs").update({ base_context_version_id: versionId }).eq("id", claimed.id);
      if (rebaseError) throw rebaseError;
      claimed.base_context_version_id = versionId;
    }
    const spec = specFromRow(claimed);
    const { bundle, prompt } = await deps.workflow.prepareRun({ client, parent, step, run: claimed, outputs });
    const receipt = await (deps.launch ?? launchWithCredentials)({ spec, bundle, prompt: { kind: "text", text: prompt }, config: deps.config }, client);
    await markAgentRunRunning(client, claimed.id, receipt.machineId);
    return "launched";
  } catch (launchError) {
    if (launchError instanceof RoutineLeaseBusyError) {
      // The workspace's Codex login is in use. The run waits in the queue and the next pass starts it.
      await client.from("agent_runs").update({ status: "queued" }).eq("id", claimed.id).eq("status", "preparing");
      return "lease_busy";
    }
    await failStepRun({ client, runId: claimed.id, failureCode: "step_launch_failed", reason: `Launching step ${step.key} failed`, error: launchError, detail: { stage: "launch" } });
    return "failed";
  }
}
