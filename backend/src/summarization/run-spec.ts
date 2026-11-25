import type { BuiltInRoutineConfig } from "../routines/built-in-config";
import { SANDBOX_RUN_DIRECTORY, cronTrigger, parseAgentRunId, parseContextVersionId, parseWorkspaceId, sandboxComputer, sandboxExecution, type AgentRunSpec, type JsonSchema } from "draft-core/run-spec";
import { cloudToolsetFor, requireRoutineAdapter } from "draft-core/harnesses";

export interface SummarizationRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
  occurrenceAt: string;
  /** A run always names a context version. Summarization does not read it. */
  contextVersionId: string;
  resultSchema: JsonSchema;
  settings?: BuiltInRoutineConfig;
}

/** A batch that summarizes the sessions it claimed. It reads no shared context and calls no Draft tool. */
export function buildSummarizationRunSpec(input: SummarizationRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.id),
    kind: "summarization",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: cronTrigger(input.scheduledTaskId, input.occurrenceAt),
    onBehalfOf: null,
    execution: sandboxExecution(requireRoutineAdapter(input.settings?.harness ?? "claude")),
    toolset: cloudToolsetFor(input.settings?.harness ?? "claude"),
    computer: sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY),
    harness: input.settings?.harness ?? "claude",
    model: input.settings?.model ?? null,
    reasoningEffort: input.settings?.reasoningEffort ?? null,
    instructions: input.settings?.prompt ?? "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
