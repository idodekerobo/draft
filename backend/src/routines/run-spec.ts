import { cloudToolsetFor } from "draft-core/harnesses";
import { cronTrigger, parseAgentRunId, parseContextVersionId, parseConnectionId, parseUserId, parseWorkspaceId, type AgentRunSpec, type AgentRunTrigger } from "draft-core/run-spec";
import { ROUTINE_READ_PERMISSIONS, type AnyDraftToolPermission } from "draft-core/tools";
import { effectiveBuiltInTools, type AgentRoutineConfig } from "./config";

/** What a routine may call through Draft today. It reads and writes context. */
export const ROUTINE_PERMISSIONS = ROUTINE_READ_PERMISSIONS;

/** Built-in tools every routine has, whatever it picked: reading for Claude Code, the shell Codex always runs. Synthesis never gets a shell. */
export const ROUTINE_ALWAYS_ON_NATIVE_TOOLS: Record<AgentRoutineConfig["harness"], ReadonlyArray<string>> = {
  claude: ["Grep"],
  codex: ["shell"],
};

/** A routine that may message teammates: it can find people and notify any member, up to this many times a run. */
export const ROUTINE_NOTIFY_MAX_PER_RUN = 15;

/** How many routines one run may create. */
export const ROUTINE_CREATE_MAX_PER_RUN = 5;

/** What a routine may call. Messaging is off unless the routine was saved with canNotify. Routine tools are checked per call. */
export function routinePermissions(routine: Pick<AgentRoutineConfig, "canNotify" | "postChannels" | "github">): ReadonlyArray<AnyDraftToolPermission> {
  const permissions: AnyDraftToolPermission[] = [
    ...ROUTINE_PERMISSIONS,
    { tool: "routines.create", limits: { maxPerRun: ROUTINE_CREATE_MAX_PER_RUN } },
    { tool: "routines.update" }, { tool: "routines.delete" }, { tool: "routines.list" }, { tool: "routines.run" }, { tool: "routines.runs" },
  ];
  if (routine.canNotify) permissions.push({ tool: "people.find" }, { tool: "people.notify", limits: { recipients: "members", maxPerRun: ROUTINE_NOTIFY_MAX_PER_RUN } });
  if (routine.postChannels) permissions.push(
    { tool: "connections.list", provider: "slack" }, { tool: "connections.read", provider: "slack" },
    { tool: "connections.post", provider: "slack", limits: { channels: routine.postChannels, maxPerRun: 10 } },
  );
  if (routine.github) permissions.push({ tool: "github.credential", limits: routine.github });
  return permissions;
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
    network: "open",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: input.trigger ?? cronTrigger(input.scheduledTaskId, input.occurrenceAt),
    onBehalfOf: parseUserId(input.ownerUserId),
    runtime: {
      type: "cloud",
      toolset: cloudToolsetFor(input.routine.harness, {
        nativeTools: [...ROUTINE_ALWAYS_ON_NATIVE_TOOLS[input.routine.harness], ...effectiveBuiltInTools(input.routine)],
        mcpServers: (input.mcpServers ?? []).map((server) => ({ connectionId: parseConnectionId(server.connectionId), tools: server.tools })),
      }),
    },
    harness: input.routine.harness,
    model: input.routine.model,
    reasoningEffort: input.routine.reasoningEffort ?? null,
    instructions: input.routine.prompt,
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: routinePermissions(input.routine),
    output: { type: "text" },
  };
}
