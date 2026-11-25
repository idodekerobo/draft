import type { BuiltInRoutineConfig } from "../routines/built-in-config";
import { AGENT_RUN_SYSTEM_REASONS, SANDBOX_RUN_DIRECTORY, cronTrigger, sandboxComputer, sandboxExecution, parseAgentRunId, parseContextVersionId, parseWorkspaceId, type AgentRunSpec, type AgentRunSystemReason, type AgentRunTrigger, type JsonSchema } from "draft-core/run-spec";
import { type AnyDraftToolPermission } from "draft-core/tools";
import { cloudToolsetFor, requireRoutineAdapter } from "draft-core/harnesses";
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
  settings?: BuiltInRoutineConfig;
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
export function synthesisTriggerType(trigger: unknown): SynthesisRunTriggerType | "event" {
  const saved = trigger as { type?: string; reason?: string } | null;
  if (saved?.type === "cron") return "schedule";
  if (saved?.type === "retry") return "retry";
  if (saved?.type === "event") return "event";
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
    onBehalfOf: null,
    execution: sandboxExecution(requireRoutineAdapter(input.settings?.harness ?? "claude")),
    toolset: cloudToolsetFor(input.settings?.harness ?? "claude"),
    computer: sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY),
    harness: input.settings?.harness ?? "claude",
    model: input.settings?.model ?? null,
    reasoningEffort: input.settings?.reasoningEffort ?? null,
    instructions: input.settings?.prompt ?? "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: input.permissions ?? [],
    output: { type: "structured", schema: input.resultSchema },
  };
}
