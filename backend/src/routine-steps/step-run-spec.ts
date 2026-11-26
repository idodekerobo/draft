import { RoutineStepsInput, resolveStepPermissions, type RoutineStep } from "draft-core/routine-steps";
import { cloudToolsetFor, requireRoutineAdapter, type HarnessId } from "draft-core/harnesses";
import { parseAgentRunId, parseContextVersionId, parseUserId, parseWorkspaceId, sandboxExecution, type AgentRunOutput, type AgentRunSpec, type AgentRunToolset, type ComputerPolicy } from "draft-core/run-spec";
import type { AnyDraftToolPermission } from "draft-core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParentRun } from "./types";

/** A step whose output is text still runs as a structured run, so its answer and transcript come back in the callback. */
export const TEXT_STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
} as const;

/** The output a step run is launched with. */
export function stepRunOutput(step: Pick<RoutineStep, "output">): AgentRunOutput {
  return step.output.type === "structured" ? { type: "structured", schema: step.output.schema } : { type: "structured", schema: TEXT_STEP_SCHEMA };
}

export interface StepRunSpecInput {
  runId: string;
  parent: ParentRun;
  step: RoutineStep;
  environment: { toolset: AgentRunToolset; computer: ComputerPolicy; model: string | null };
  /** What the routine itself may use. The step keeps only the part of its own list that is in this. */
  routinePermissions: ReadonlyArray<AnyDraftToolPermission>;
  contextVersionId: string;
}

/** The run behind one step run, in the typed contract. It acts as the parent's owner, with the parent's harness. */
export function buildStepRunSpec(input: StepRunSpecInput): AgentRunSpec {
  const { parent, step } = input;
  const harness = parent.harness as HarnessId;
  return {
    id: parseAgentRunId(input.runId),
    kind: "step",
    workspaceId: parseWorkspaceId(parent.workspace_id),
    trigger: { type: "step", parentRunId: parseAgentRunId(parent.id), parentKind: parent.kind },
    onBehalfOf: parent.on_behalf_of_user_id ? parseUserId(parent.on_behalf_of_user_id) : null,
    execution: sandboxExecution(requireRoutineAdapter(harness)),
    toolset: input.environment.toolset,
    computer: input.environment.computer,
    harness,
    model: step.model ?? input.environment.model,
    reasoningEffort: parent.reasoning_effort ?? null,
    instructions: step.prompt,
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: resolveStepPermissions(step, input.routinePermissions),
    output: stepRunOutput(step),
  };
}

/** The steps a parent run was started with. They are saved on the parent so editing the routine cannot change a run in flight. */
export function stepsOfParent(parent: Pick<ParentRun, "result_json">): RoutineStep[] | null {
  const saved = (parent.result_json as { steps?: unknown } | null)?.steps;
  const parsed = RoutineStepsInput.safeParse(saved);
  return parsed.success ? (parsed.data as RoutineStep[]) : null;
}

/** Saves the steps on the parent. Done once, when the run starts. */
export async function saveStepsOnParent(client: SupabaseClient, parentRunId: string, steps: ReadonlyArray<RoutineStep>): Promise<void> {
  const { error } = await client.from("agent_runs").update({ result_json: { steps } }).eq("id", parentRunId);
  if (error) throw error;
}
