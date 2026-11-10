import {
  parseAgentRunId,
  parseContextVersionId,
  parseIsoTimestamp,
  parseScheduledTaskId,
  parseWorkspaceId,
  type AgentRunSpec,
  type JsonSchema,
} from "draft-core/agent-run";
import { routineEnvironment } from "../routines/run-spec";

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
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: {
      type: "cron",
      scheduledTaskId: parseScheduledTaskId(input.scheduledTaskId),
      occurrenceAt: parseIsoTimestamp(input.occurrenceAt),
    },
    principal: { type: "workspace" },
    runtime: { type: "cloud", environment: routineEnvironment("claude") },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
