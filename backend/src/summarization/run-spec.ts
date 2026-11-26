import type { BuiltInRoutineConfig } from "../routines/built-in-config";
import { buildBuiltInRunSpec } from "../routines/built-in-run-spec";
import { cronTrigger, type AgentRunSpec, type JsonSchema } from "draft-core/run-spec";

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
  return buildBuiltInRunSpec({
    id: input.id,
    kind: "summarization",
    workspaceId: input.workspaceId,
    trigger: cronTrigger(input.scheduledTaskId, input.occurrenceAt),
    contextVersionId: input.contextVersionId,
    resultSchema: input.resultSchema,
    settings: input.settings,
  });
}
