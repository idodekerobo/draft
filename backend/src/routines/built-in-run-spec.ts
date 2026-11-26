import { cloudToolsetFor, requireRoutineAdapter } from "draft-core/harnesses";
import { SANDBOX_RUN_DIRECTORY, parseAgentRunId, parseContextVersionId, parseWorkspaceId, sandboxComputer, sandboxExecution, type AgentRunKind, type AgentRunSpec, type AgentRunTrigger, type JsonSchema } from "draft-core/run-spec";
import type { AnyDraftToolPermission } from "draft-core/tools";
import type { BuiltInRoutineConfig } from "./built-in-config";

export interface BuiltInRunSpecInput {
  id: string;
  kind: Extract<AgentRunKind, "synthesis" | "summarization">;
  workspaceId: string;
  trigger: AgentRunTrigger;
  /** The version the run's files come from. A run always names one, even when it does not read it. */
  contextVersionId: string;
  resultSchema: JsonSchema;
  settings?: BuiltInRoutineConfig;
  permissions?: ReadonlyArray<AnyDraftToolPermission>;
}

/** What every built-in routine's run has in common: the team's settings, a restricted sandbox, a structured result. */
export function buildBuiltInRunSpec(input: BuiltInRunSpecInput): AgentRunSpec {
  const harness = input.settings?.harness ?? "claude";
  return {
    id: parseAgentRunId(input.id),
    kind: input.kind,
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: input.trigger,
    onBehalfOf: null,
    execution: sandboxExecution(requireRoutineAdapter(harness)),
    toolset: cloudToolsetFor(harness),
    computer: sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY),
    harness,
    model: input.settings?.model ?? null,
    reasoningEffort: input.settings?.reasoningEffort ?? null,
    instructions: input.settings?.prompt ?? "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: input.permissions ?? [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
