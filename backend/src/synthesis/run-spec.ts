import { AGENT_RUN_SYSTEM_REASONS, agentActor, cronTrigger, parseAgentRunId, parseContextVersionId, parseWorkspaceId, type AgentRunSpec, type AgentRunSystemReason, type AgentRunTrigger, type JsonSchema } from "draft-core/run-spec";
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
 * How a synthesis run started, in the typed contract.
 */
export function synthesisTrigger(input: Pick<SynthesisRunSpecInput, "triggerType" | "scheduledTaskId" | "occurrenceAt" | "retryOfRunId">): AgentRunTrigger {
  if (input.triggerType === "schedule" && input.scheduledTaskId && input.occurrenceAt) {
    return cronTrigger(input.scheduledTaskId, input.occurrenceAt);
  }
  if (input.triggerType === "retry" && input.retryOfRunId) return { type: "retry", retryOf: parseAgentRunId(input.retryOfRunId) };
  const reason = (AGENT_RUN_SYSTEM_REASONS as ReadonlyArray<string>).includes(input.triggerType) ? (input.triggerType as AgentRunSystemReason) : "manual";
  return { type: "system", reason };
}

/** The trigger type a person sees for a saved run. The inverse of synthesisTrigger. */
export function synthesisTriggerType(trigger: unknown): SynthesisRunTriggerType {
  const saved = trigger as { type?: string; reason?: string } | null;
  if (saved?.type === "cron") return "schedule";
  if (saved?.type === "retry") return "retry";
  const reasons: ReadonlyArray<string> = ["source_threshold", "manual", "stale_requeue", "seed_test"];
  return saved?.type === "system" && saved.reason && reasons.includes(saved.reason) ? (saved.reason as SynthesisRunTriggerType) : "manual";
}

/** The run behind a nightly or on-demand synthesis, as the foundation sees it. */
export function buildSynthesisRunSpec(input: SynthesisRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.runId),
    kind: "synthesis",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: synthesisTrigger(input),
    actor: agentActor(parseAgentRunId(input.runId)),
    onBehalfOf: null,
    runtime: { type: "cloud", environment: cloudEnvironmentFor("claude") },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: input.permissions ?? [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
