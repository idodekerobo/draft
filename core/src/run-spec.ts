/**
 * The contract for one agent run. Draft builds one AgentRunSpec per run, saves it,
 * and every surface the run touches (launch, tool gateway, audit) reads it from here.
 */
import { cloudNativeToolsFor, getAdapter, isNativeTool, type AdapterId } from "./harnesses/adapters";
import type { HarnessId } from "./harnesses";
import type { AnyDraftToolPermission } from "./tools";


type Brand<T, B extends string> = T & { readonly __brand: B };

export type AgentRunId = Brand<string, "AgentRunId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
export type PersonId = Brand<string, "PersonId">;
export type ContextVersionId = Brand<string, "ContextVersionId">;
export type ScheduledTaskId = Brand<string, "ScheduledTaskId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type HostId = Brand<string, "HostId">;
export type SkillId = Brand<string, "SkillId">;
export type InstructionFileId = Brand<string, "InstructionFileId">;
export type AgentEventId = Brand<string, "AgentEventId">;
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
/** Marked pure so the sandbox runner bundle stays the same when it does not use it. */
export const parsePersonId = /* @__PURE__ */ uuidParser<PersonId>("PersonId");
export const parseContextVersionId = uuidParser<ContextVersionId>("ContextVersionId");
export const parseScheduledTaskId = uuidParser<ScheduledTaskId>("ScheduledTaskId");
export const parseConnectionId = uuidParser<ConnectionId>("ConnectionId");
export const parseSkillId = uuidParser<SkillId>("SkillId");
export const parseInstructionFileId = uuidParser<InstructionFileId>("InstructionFileId");
/** Marked pure, like parsePersonId, so the sandbox runner bundle does not change when it does not use it. */
export const parseAgentEventId = /* @__PURE__ */ uuidParser<AgentEventId>("AgentEventId");

/** A host id comes from the desktop app and is not always a UUID. */
export function parseHostId(raw: string): HostId {
  if (!raw.trim()) throw new Error("Invalid HostId: empty");
  return raw as HostId;
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
  | { type: "event"; eventIds: ReadonlyArray<AgentEventId> }
  | { type: "manual"; requestedBy: UserId }
  | { type: "retry"; retryOf: AgentRunId };

/** The trigger of a run that a schedule started. Both values come from the database and are checked here. */
export function cronTrigger(scheduledTaskId: string, occurrenceAt: string): AgentRunTrigger {
  return { type: "cron", scheduledTaskId: parseScheduledTaskId(scheduledTaskId), occurrenceAt: parseIsoTimestamp(occurrenceAt) };
}

export { CLAUDE_NATIVE_TOOLS, type ClaudeNativeTool } from "./harnesses/claude/adapters";
export { CODEX_NATIVE_TOOLS, type CodexNativeTool } from "./harnesses/codex/adapters";
export { cloudNativeToolsFor, isNativeTool };

/** A built-in tool of a harness. The adapter registry says which tool names each harness has. */
export interface NativeToolPermission {
  harness: HarnessId;
  tool: string;
}

/**
 * True when a cloud run may be given the tool. Tools that need a display are left out. The sandbox never
 * holds a secret, so a tool that needs one is reached through Draft's gateway instead.
 */
export function isCloudNativeTool(permission: NativeToolPermission): boolean {
  return cloudNativeToolsFor(permission.harness).includes(permission.tool);
}

/** An MCP server the person connected in Draft. Tool names come from the server at run time. */
export interface McpServerPermission {
  connectionId: ConnectionId;
  tools: "all" | ReadonlyArray<string>;
}

export interface AgentRunToolset {
  nativeTools: ReadonlyArray<NativeToolPermission>;
  mcpServers: ReadonlyArray<McpServerPermission>;
  skills: ReadonlyArray<SkillId>;
  instructions: ReadonlyArray<InstructionFileId>;
}

/**
 * Where Draft sends a run. `host` is an already-registered, running host; `sandbox` is one Draft starts (its image is a
 * launch fact, not part of the spec); `backend` is Draft's own backend running the agent loop.
 */
export type ExecutionTarget =
  | { type: "host"; hostId: HostId }
  | { type: "sandbox" }
  | { type: "backend"; packageVersion: string };

/** Which computer a run's file and command tools may act on. Separate from where the agent loop runs. */
export type ComputerPolicy =
  | { type: "host_computer"; computerId: string; workingDirectory: string }
  | { type: "sandbox"; profileId: string; workingDirectory: string; network: "open" | "restricted" }
  | { type: "none" };

/** What a run resumes earlier agent state from. Omitted on a fresh launch. */
export type RunContinuation =
  | { type: "native"; nativeSessionId: string }
  | { type: "durable"; storageId: string; conversationId: number };

export interface AgentRunExecution {
  target: ExecutionTarget;
  adapterId: AdapterId;
}

/** The sandbox folder a cloud session's agent works in. */
export const SANDBOX_SESSION_DIRECTORY = "/data/workspace";
/** The sandbox folder that holds the files of a one-shot run. */
export const SANDBOX_RUN_DIRECTORY = "/run";
const DEFAULT_SANDBOX_PROFILE = "default";

export const sandboxExecution = (adapterId: AdapterId): AgentRunExecution => ({ target: { type: "sandbox" }, adapterId });

export const sandboxComputer = (network: "open" | "restricted", workingDirectory: string): ComputerPolicy =>
  ({ type: "sandbox", profileId: DEFAULT_SANDBOX_PROFILE, workingDirectory, network });

/** What a person sees: a `host` target is "This computer" (`local`); a sandbox or backend target is "Draft Cloud" (`cloud`). */
export const runtimeOfTarget = (target: ExecutionTarget["type"]): "local" | "cloud" => (target === "host" ? "local" : "cloud");

/** The network a run's sandbox allows. Runs that do not use a sandbox computer get the restricted default. */
export const networkOf = (computer: ComputerPolicy): "open" | "restricted" => (computer.type === "sandbox" ? computer.network : "restricted");

/** Why a run's target, adapter and computer cannot go together, or null when they can. */
export function executionProblem(spec: Pick<AgentRunSpec, "harness" | "execution" | "computer">): string | null {
  const adapter = getAdapter(spec.execution.adapterId);
  if (!adapter) return `Unknown adapter: ${spec.execution.adapterId}`;
  if (adapter.harness !== spec.harness) return `Adapter ${adapter.id} does not run harness ${spec.harness}`;
  const target = spec.execution.target.type;
  if (!adapter.targets.includes(target)) return `Adapter ${adapter.id} cannot run on a ${target} target`;
  if (target === "host" && spec.computer.type === "sandbox") return "A host target cannot use a sandbox computer";
  if (target === "sandbox" && spec.computer.type === "host_computer") return "A sandbox target cannot use a host computer";
  if (target === "backend" && spec.computer.type === "host_computer") return "A backend target cannot use a host computer";
  return null;
}

/** Why a run cannot be launched now, or null. A spec may name an adapter that is registered but has no launcher yet. */
export function launchProblem(spec: Pick<AgentRunSpec, "harness" | "execution" | "computer">): string | null {
  const problem = executionProblem(spec);
  if (problem) return problem;
  const adapter = getAdapter(spec.execution.adapterId);
  return adapter && !adapter.launchable ? `Adapter ${adapter.id} cannot be launched yet` : null;
}

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
  /**
   * The user whose connections and context the run may use, and who "self" is. This is authority lent to
   * the run, not the actor. Null for a workspace run on shared sources, which has no self.
   */
  onBehalfOf: UserId | null;
  execution: AgentRunExecution;
  /** Cloud: an allow-list. Local: only what Draft adds; the person's own tools stay on. */
  toolset: AgentRunToolset;
  computer: ComputerPolicy;
  continuation?: RunContinuation;
  harness: HarnessId;
  /** A model alias of the harness, or null for the harness default. */
  model: string | null;
  /** A reasoning effort the model accepts, or null for the harness default. */
  reasoningEffort?: string | null;
  instructions: string;
  inputs: { contextVersionId: ContextVersionId };
  permissions: ReadonlyArray<AnyDraftToolPermission>;
  output: AgentRunOutput;
}
