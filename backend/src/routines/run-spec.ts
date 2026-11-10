import type { HarnessId } from "draft-core/harnesses";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseIsoTimestamp,
  parseScheduledTaskId,
  parseWorkspaceId,
  isCloudNativeTool,
  parseSourceConnectionId,
  type AgentRunEnvironment,
  type AgentRunSpec,
  type AnyDraftToolPermission,
  type McpServerPermission,
  type NativeToolPermission,
} from "draft-core/agent-run";
import type { AgentRoutineConfig } from "./config";

/** What a routine may call through Draft today. It reads and writes context. */
export const ROUTINE_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [{ tool: "context.read" }, { tool: "context.write" }];

/** The built-in tools the runner starts each harness with. They match runner.ts. */
const DEFAULT_NATIVE_TOOLS: Record<HarnessId, ReadonlyArray<NativeToolPermission>> = {
  claude: [
    { harness: "claude", tool: "Read" },
    { harness: "claude", tool: "Glob" },
  ],
  codex: [{ harness: "codex", tool: "shell" }],
};

/**
 * What a routine's run may use: the defaults, the built-in tools the person added, and the connections
 * they chose that are still usable. The config was checked when it was saved, and is checked again here.
 */
export function routineEnvironment(
  harness: HarnessId,
  chosen?: { nativeTools: ReadonlyArray<string>; mcpServers: ReadonlyArray<McpServerPermission> },
): AgentRunEnvironment {
  const nativeTools: NativeToolPermission[] = [...DEFAULT_NATIVE_TOOLS[harness]];
  for (const tool of chosen?.nativeTools ?? []) {
    const permission = { harness, tool } as NativeToolPermission;
    if (isCloudNativeTool(permission) && !nativeTools.some((existing) => existing.tool === permission.tool)) nativeTools.push(permission);
  }
  return { nativeTools, mcpServers: [...(chosen?.mcpServers ?? [])], skills: [], instructions: [] };
}

export interface RoutineRunSpecInput {
  id: string;
  workspaceId: string;
  scheduledTaskId: string;
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
    trigger: {
      type: "cron",
      scheduledTaskId: parseScheduledTaskId(input.scheduledTaskId),
      occurrenceAt: parseIsoTimestamp(input.occurrenceAt),
    },
    principal: { type: "workspace" },
    runtime: {
      type: "cloud",
      environment: routineEnvironment(input.routine.harness, {
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
