import { AGENT_RUN_SYSTEM_REASONS, cronTrigger, parseAgentRunId, parseContextVersionId, parseWorkspaceId, type AgentRunSpec, type AgentRunSystemReason, type AgentRunTrigger, type JsonSchema } from "draft-core/run-spec";
import { type AnyDraftToolPermission } from "draft-core/tools";
import { cloudEnvironmentFor } from "draft-core/harnesses";
import type { SynthesisRunTriggerType } from "../types/enums";

export interface SynthesisRunSpecInput {
  runId: string;
  workspaceId: string;
  triggerType: SynthesisRunTriggerType;
  scheduledTaskId?: string;
  occurrenceAt?: string;
  retryOfRunId?: string;
  /** The version the run's files come from. */
  contextVersionId: string;
  resultSchema: JsonSchema;
  permissions?: ReadonlyArray<AnyDraftToolPermission>;
}

/**
 * How a synthesis run started, in the typed contract. The database trigger that copies synthesis runs
 * to agent_runs maps the same way (supabase/migrations/…_synthesis_runs_mirror.sql); a test holds them together.
 */
export function synthesisTrigger(input: Pick<SynthesisRunSpecInput, "triggerType" | "scheduledTaskId" | "occurrenceAt" | "retryOfRunId">): AgentRunTrigger {
  if (input.triggerType === "schedule" && input.scheduledTaskId && input.occurrenceAt) {
    return cronTrigger(input.scheduledTaskId, input.occurrenceAt);
  }
  if (input.triggerType === "retry" && input.retryOfRunId) return { type: "retry", retryOf: parseAgentRunId(input.retryOfRunId) };
  const reason = (AGENT_RUN_SYSTEM_REASONS as ReadonlyArray<string>).includes(input.triggerType) ? (input.triggerType as AgentRunSystemReason) : "manual";
  return { type: "system", reason };
}

/** The run behind a nightly or on-demand synthesis, as the foundation sees it. */
export function buildSynthesisRunSpec(input: SynthesisRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.runId),
    kind: "synthesis",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: synthesisTrigger(input),
    principal: { type: "workspace" },
    runtime: { type: "cloud", environment: cloudEnvironmentFor("claude") },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: input.permissions ?? [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
