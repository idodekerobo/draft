/**
 * The contract for one agent run. Draft builds one AgentRunSpec per run, saves it,
 * and every surface the run touches (launch, tool gateway, audit) reads it from here.
 */
import type { HarnessId } from "./harnesses";
import type { AnyDraftToolPermission } from "./tools";


type Brand<T, B extends string> = T & { readonly __brand: B };

export type AgentRunId = Brand<string, "AgentRunId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
export type ContextVersionId = Brand<string, "ContextVersionId">;
export type ScheduledTaskId = Brand<string, "ScheduledTaskId">;
export type SourceConnectionId = Brand<string, "SourceConnectionId">;
export type HostMachineId = Brand<string, "HostMachineId">;
export type SkillId = Brand<string, "SkillId">;
export type InstructionFileId = Brand<string, "InstructionFileId">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParser<T extends string>(label: string) {
  return (raw: string): T => {
    if (!UUID.test(raw)) throw new Error(`Invalid ${label}: ${JSON.stringify(raw)}`);
    return raw as T;
  };
}

export const parseAgentRunId = uuidParser<AgentRunId>("AgentRunId");
export const parseWorkspaceId = uuidParser<WorkspaceId>("WorkspaceId");
export const parseUserId = uuidParser<UserId>("UserId");
export const parseContextVersionId = uuidParser<ContextVersionId>("ContextVersionId");
export const parseScheduledTaskId = uuidParser<ScheduledTaskId>("ScheduledTaskId");
export const parseSourceConnectionId = uuidParser<SourceConnectionId>("SourceConnectionId");
export const parseSkillId = uuidParser<SkillId>("SkillId");
export const parseInstructionFileId = uuidParser<InstructionFileId>("InstructionFileId");

/** A host machine id comes from the desktop app and is not always a UUID. */
export function parseHostMachineId(raw: string): HostMachineId {
  if (!raw.trim()) throw new Error("Invalid HostMachineId: empty");
  return raw as HostMachineId;
}

export function parseIsoTimestamp(raw: string): IsoTimestamp {
  if (Number.isNaN(Date.parse(raw))) throw new Error(`Invalid IsoTimestamp: ${JSON.stringify(raw)}`);
  return raw as IsoTimestamp;
}

export const AGENT_RUN_KINDS = ["interactive", "routine", "synthesis", "summarization"] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

export const AGENT_RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "validating",
  "committing",
  "succeeded",
  "failed",
  "stale",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** A run in one of these is still going. Anything else has finished. */
export const ACTIVE_AGENT_RUN_STATUSES = ["queued", "preparing", "running", "validating", "committing"] as const satisfies ReadonlyArray<AgentRunStatus>;

/** Providers that can wake a run through a webhook. */
export type AgentRunWebhookProvider = "slack" | "github" | "linear" | "fireflies" | "granola";

/** Why Draft started a run on its own, when no schedule or person did. */
export const AGENT_RUN_SYSTEM_REASONS = ["manual", "source_threshold", "stale_requeue", "seed_test"] as const;
export type AgentRunSystemReason = (typeof AGENT_RUN_SYSTEM_REASONS)[number];

export type AgentRunTrigger =
  | { type: "cron"; scheduledTaskId: ScheduledTaskId; occurrenceAt: IsoTimestamp }
  | { type: "system"; reason: AgentRunSystemReason }
  | { type: "webhook"; provider: AgentRunWebhookProvider; eventId: string }
  | { type: "manual"; requestedBy: UserId }
  | { type: "retry"; retryOf: AgentRunId };

/** Who the run acts for. Only the workspace exists today. Identity work adds a user case. */
export type AgentRunPrincipal = { type: "workspace" };

/** Claude Code tools a run may be given. Which of them are safe in the cloud is decided by the cloud environment. */
export const CLAUDE_NATIVE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Bash", "Edit", "Write"] as const;
export type ClaudeNativeTool = (typeof CLAUDE_NATIVE_TOOLS)[number];

export const CODEX_NATIVE_TOOLS = ["web_search", "shell", "apply_patch"] as const;
export type CodexNativeTool = (typeof CODEX_NATIVE_TOOLS)[number];

export type NativeToolPermission =
  | { harness: "claude"; tool: ClaudeNativeTool }
  | { harness: "codex"; tool: CodexNativeTool };

/**
 * The built-in tools a cloud run may be given. The rest either run inside the sandbox and widen what
 * it can do (Bash, Edit, Write, WebFetch), or need a display. The sandbox never holds a secret, so a
 * tool that needs one is reached through Draft's gateway instead.
 */
export const CLOUD_NATIVE_TOOLS = {
  claude: ["Read", "Glob", "Grep", "WebSearch"],
  codex: ["shell", "web_search"],
} as const satisfies { claude: ReadonlyArray<ClaudeNativeTool>; codex: ReadonlyArray<CodexNativeTool> };

export function isCloudNativeTool(permission: NativeToolPermission): boolean {
  return (CLOUD_NATIVE_TOOLS[permission.harness] as ReadonlyArray<string>).includes(permission.tool);
}

/** An MCP server the person connected in Draft. Tool names come from the server at run time. */
export interface McpServerPermission {
  connectionId: SourceConnectionId;
  tools: "all" | ReadonlyArray<string>;
}

export interface AgentRunEnvironment {
  nativeTools: ReadonlyArray<NativeToolPermission>;
  mcpServers: ReadonlyArray<McpServerPermission>;
  skills: ReadonlyArray<SkillId>;
  instructions: ReadonlyArray<InstructionFileId>;
}

export type AgentRunRuntime =
  | { type: "local"; hostMachineId: HostMachineId }
  | { type: "cloud"; environment: AgentRunEnvironment };

export type JsonSchema = Readonly<Record<string, unknown>>;

export type AgentRunOutput =
  | { type: "text" }
  | { type: "structured"; schema: JsonSchema }
  | { type: "none" };

export interface AgentRunSpec {
  id: AgentRunId;
  kind: AgentRunKind;
  workspaceId: WorkspaceId;
  trigger: AgentRunTrigger;
  principal: AgentRunPrincipal;
  runtime: AgentRunRuntime;
  harness: HarnessId;
  /** A model alias of the harness, or null for the harness default. */
  model: string | null;
  instructions: string;
  inputs: { contextVersionId: ContextVersionId };
  permissions: ReadonlyArray<AnyDraftToolPermission>;
  output: AgentRunOutput;
}
