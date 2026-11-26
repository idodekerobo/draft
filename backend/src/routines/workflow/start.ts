import type { RoutineStep } from "draft-core/routine-steps";
import { markAgentRunRunning } from "../../metaharness/runs/lifecycle";
import { advanceWorkflow, type AdvanceState } from "./advance";
import { saveStepsOnParent } from "./step-run-spec";
import type { EngineDeps } from "./types";

/**
 * Starts a routine's run that has steps. The steps are saved on the run first, so editing the routine cannot change a
 * run that has started. The run starts no agent itself: the engine starts its step runs.
 */
export async function startWorkflow(
  deps: EngineDeps,
  input: { parentRunId: string; steps: ReadonlyArray<RoutineStep>; extras?: Record<string, unknown> },
): Promise<AdvanceState> {
  await saveStepsOnParent(deps.client, input.parentRunId, input.steps, input.extras);
  await markAgentRunRunning(deps.client, input.parentRunId);
  return advanceWorkflow(deps, input.parentRunId);
}
