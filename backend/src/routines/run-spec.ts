import { cloudEnvironmentFor } from "draft-core/harnesses";
import { agentActor, cronTrigger, parseAgentRunId, parseContextVersionId, parseSourceConnectionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { CONTEXT_READ_WRITE_PERMISSIONS, type AnyDraftToolPermission } from "draft-core/tools";
import type { AgentRoutineConfig } from "./config";

/** What a routine may call through Draft today. It reads and writes context. */
export const ROUTINE_PERMISSIONS = CONTEXT_READ_WRITE_PERMISSIONS;

export interface RoutineRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
  /** The routine's owner. The run acts as this user. */
  ownerUserId: string;
  occurrenceAt: string;
  routine: AgentRoutineConfig;
  /** The context version the run's files come from. */
  contextVersionId: string;
  /** The connections the run may use, already checked as usable by its owner. */
  mcpServers?: ReadonlyArray<{ connectionId: string; tools: "all" | string[] }>;
}

export function buildRoutineRunSpec(input: RoutineRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.id),
    kind: "routine",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: cronTrigger(input.scheduledTaskId, input.occurrenceAt),
    actor: agentActor(parseAgentRunId(input.id)),
    onBehalfOf: parseUserId(input.ownerUserId),
    runtime: {
      type: "cloud",
      environment: cloudEnvironmentFor(input.routine.harness, {
        nativeTools: input.routine.environment?.nativeTools ?? [],
        mcpServers: (input.mcpServers ?? []).map((server) => ({ connectionId: parseSourceConnectionId(server.connectionId), tools: server.tools })),
      }),
    },
    harness: input.routine.harness,
    model: input.routine.model,
    instructions: input.routine.prompt,
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: ROUTINE_PERMISSIONS,
    output: { type: "text" },
  };
}
