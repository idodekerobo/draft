import { cloudEnvironmentFor } from "draft-core/harnesses";
import { agentActor, cronTrigger, parseAgentRunId, parseContextVersionId, parseSourceConnectionId, parseUserId, parseWorkspaceId, type AgentRunSpec, type AgentRunTrigger } from "draft-core/run-spec";
import { CONTEXT_READ_WRITE_PERMISSIONS, type AnyDraftToolPermission } from "draft-core/tools";
import type { AgentRoutineConfig } from "./config";

/** What a routine may call through Draft today. It reads and writes context. */
export const ROUTINE_PERMISSIONS = CONTEXT_READ_WRITE_PERMISSIONS;

/** A routine that may message teammates: it can find people and notify any member, up to this many times a run. */
export const ROUTINE_NOTIFY_MAX_PER_RUN = 15;

/** What a routine may call. Messaging is off unless the routine was saved with canNotify. */
export function routinePermissions(routine: Pick<AgentRoutineConfig, "canNotify">): ReadonlyArray<AnyDraftToolPermission> {
  if (!routine.canNotify) return ROUTINE_PERMISSIONS;
  return [...ROUTINE_PERMISSIONS, { tool: "people.find" }, { tool: "people.notify", limits: { recipients: "members", maxPerRun: ROUTINE_NOTIFY_MAX_PER_RUN } }];
}

export interface RoutineRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
  /** The routine's owner. The run acts as this user. */
  ownerUserId: string;
  occurrenceAt: string;
  /** Why the run started, when it was not the schedule. Defaults to the cron occurrence. */
  trigger?: AgentRunTrigger;
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
    trigger: input.trigger ?? cronTrigger(input.scheduledTaskId, input.occurrenceAt),
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
    permissions: routinePermissions(input.routine),
    output: { type: "text" },
  };
}
