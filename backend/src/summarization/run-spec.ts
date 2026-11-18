import { cronTrigger, parseAgentRunId, parseContextVersionId, parseWorkspaceId, type AgentRunSpec, type JsonSchema } from "draft-core/run-spec";
import { cloudToolsetFor } from "draft-core/harnesses";

export interface SummarizationRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
  occurrenceAt: string;
  /** A run always names a context version. Summarization does not read it. */
  contextVersionId: string;
  resultSchema: JsonSchema;
}

/** A batch that summarizes the sessions it claimed. It reads no shared context and calls no Draft tool. */
export function buildSummarizationRunSpec(input: SummarizationRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.id),
    kind: "summarization",
    network: "restricted",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: cronTrigger(input.scheduledTaskId, input.occurrenceAt),
    onBehalfOf: null,
    runtime: { type: "cloud", environment: cloudToolsetFor("claude") },
    harness: "claude",
    model: null,
    reasoningEffort: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
