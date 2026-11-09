import type { HarnessId } from "draft-core/harnesses";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseIsoTimestamp,
  parseScheduledTaskId,
  parseWorkspaceId,
  type AgentRunEnvironment,
  type AgentRunSpec,
  type AnyDraftToolPermission,
} from "draft-core/agent-run";
import type { AgentRoutineConfig } from "./config";

/**
 * What a routine may call through Draft today. It reads context and can ask a person a question.
 * context.write is not granted yet: a write during a synthesis run would make that run stale.
 */
export const ROUTINE_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [{ tool: "context.read" }, { tool: "request_input" }];

/** The built-in tools the runner starts each harness with. They match runner.ts. */
export function routineEnvironment(harness: HarnessId): AgentRunEnvironment {
  return {
    nativeTools:
      harness === "codex"
        ? [{ harness: "codex", tool: "shell" }]
        : [
            { harness: "claude", tool: "Read" },
            { harness: "claude", tool: "Glob" },
          ],
    mcpServers: [],
    skills: [],
    instructions: [],
  };
}

export interface RoutineRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
  occurrenceAt: string;
  routine: AgentRoutineConfig;
  /** The context version the run's files come from. */
  contextVersionId: string;
}

export function buildRoutineRunSpec(input: RoutineRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.id),
    kind: "routine",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: {
      type: "cron",
      scheduledTaskId: parseScheduledTaskId(input.scheduledTaskId),
      occurrenceAt: parseIsoTimestamp(input.occurrenceAt),
    },
    principal: { type: "workspace" },
    runtime: { type: "cloud", environment: routineEnvironment(input.routine.harness) },
    harness: input.routine.harness,
    model: input.routine.model,
    instructions: input.routine.prompt,
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: ROUTINE_PERMISSIONS,
    output: { type: "text" },
  };
}
