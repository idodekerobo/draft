/**
 * The tools Draft's gateway serves, what a person may limit on them, and who may call them.
 */
import { AGENT_RUN_KINDS, type AgentRunKind, type AgentRunSpec, type PersonId, type UserId, type WorkspaceId } from "./run-spec";

/** Every tool the Draft gateway can serve. Adding a tool starts here. */
export const DRAFT_TOOLS = [
  { name: "context.read", access: "read" },
  { name: "context.write", access: "write" },
  { name: "context.list", access: "read" },
  { name: "context.export", access: "read" },
  { name: "sources.search", access: "read" },
  { name: "sources.list", access: "read" },
  { name: "sources.read", access: "read" },
  { name: "sessions.list", access: "read" },
  { name: "sessions.read", access: "read" },
  { name: "skills.list", access: "read" },
  { name: "skills.read", access: "read" },
  { name: "skills.add", access: "write" },
  { name: "skills.update", access: "write" },
  { name: "skills.delete", access: "write" },
  { name: "routines.list", access: "read" },
  { name: "routines.create", access: "write" },
  { name: "routines.update", access: "write" },
  { name: "routines.delete", access: "write" },
  { name: "routines.run", access: "write" },
  { name: "routines.runs", access: "read" },
  { name: "routines.options", access: "read" },
  { name: "connections.list", access: "read" },
  { name: "connections.connect", access: "write" },
  { name: "connections.disconnect", access: "write" },
  { name: "activity.list", access: "read" },
  { name: "slack.list_channels", access: "read" },
  { name: "slack.read_channel", access: "read" },
  { name: "slack.post_message", access: "write" },
  { name: "github.credential", access: "read" },
  { name: "people.find", access: "read" },
  { name: "people.create", access: "write" },
  { name: "people.add_identity", access: "write" },
  { name: "people.notify", access: "write" },
  { name: "people.approve", access: "write" },
  { name: "people.reject", access: "write" },
] as const;
export type DraftToolName = (typeof DRAFT_TOOLS)[number]["name"];
export type DraftToolAccess = (typeof DRAFT_TOOLS)[number]["access"];

export const isDraftToolName = (name: unknown): name is DraftToolName =>
  DRAFT_TOOLS.some((tool) => tool.name === name);

/** Limits a person can put on a tool. A tool with no entry has no limits. */
export interface DraftToolLimits {
  "context.read": Record<string, never>;
  "context.write": { pathPrefixes?: ReadonlyArray<string> };
  "context.list": Record<string, never>;
  "context.export": Record<string, never>;
  "sources.search": Record<string, never>;
  "sources.list": Record<string, never>;
  "sources.read": Record<string, never>;
  "sessions.list": Record<string, never>;
  "sessions.read": Record<string, never>;
  "skills.list": Record<string, never>;
  "skills.read": Record<string, never>;
  "skills.add": Record<string, never>;
  "skills.update": Record<string, never>;
  "skills.delete": Record<string, never>;
  "routines.list": Record<string, never>;
  "routines.create": { maxPerRun?: number };
  "routines.update": Record<string, never>;
  "routines.delete": Record<string, never>;
  "routines.run": Record<string, never>;
  "routines.runs": Record<string, never>;
  "routines.options": Record<string, never>;
  "connections.list": Record<string, never>;
  "connections.connect": Record<string, never>;
  "connections.disconnect": Record<string, never>;
  "activity.list": Record<string, never>;
  "slack.list_channels": Record<string, never>;
  "slack.read_channel": Record<string, never>;
  "slack.post_message": { channels?: "joined" | ReadonlyArray<string>; maxPerRun?: number };
  "github.credential": { repos?: ReadonlyArray<string>; access?: "read" | "write" };
  "people.find": Record<string, never>;
  "people.create": { maxPerRun?: number };
  "people.add_identity": { maxPerRun?: number };
  /** `recipients` is who the run may message: its own user, any member, or these people. */
  "people.notify": { recipients?: "self" | "members" | ReadonlyArray<PersonId>; maxPerRun?: number };
  "people.approve": Record<string, never>;
  "people.reject": Record<string, never>;
}

export interface DraftToolPermission<T extends DraftToolName = DraftToolName> {
  tool: T;
  limits?: DraftToolLimits[T];
}

/** A person-approved rule, saved on the run when it starts, that lets the run call one Draft tool. */
export type AnyDraftToolPermission = { [T in DraftToolName]: DraftToolPermission<T> }[DraftToolName];

/** What a routine and a synthesis run may do with Draft's tools today: read any context and write any document. */
export const CONTEXT_READ_WRITE_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [{ tool: "context.read" }, { tool: "context.write" }];

/** What a routine may read from the shared company brain. */
export const ROUTINE_READ_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [
  { tool: "context.read" }, { tool: "context.list" }, { tool: "context.write" },
  { tool: "sources.search" }, { tool: "sources.list" }, { tool: "sources.read" }, { tool: "skills.list" }, { tool: "skills.read" },
];

/** What a synthesis run may do: read and write context, and note new teammates. It can never message anyone. */
export const SYNTHESIS_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [
  ...CONTEXT_READ_WRITE_PERMISSIONS,
  { tool: "people.find" },
  { tool: "people.create", limits: { maxPerRun: 5 } },
  { tool: "people.add_identity", limits: { maxPerRun: 10 } },
];

/** Where a call came in. `app` is an older app with an unknown surface; only CLI/MCP count as external agent queries. */
export type UserCallSurface = "mcp" | "cli" | "web_app" | "desktop_app" | "app";

/** Where a call comes from: a signed-in person through one surface, or an agent run. */
export type CallerOrigin =
  | { kind: "person"; userId: UserId; via: UserCallSurface }
  | { kind: "run"; run: AgentRunSpec };

/** Who is calling a tool. Each surface proves this its own way, then hands the gateway this value. */
export type ToolCaller = {
  workspaceId: WorkspaceId;
  /** Whose private data the call may use. Null means the workspace's shared data only. A person is their own userId. */
  onBehalfOf: UserId | null;
  origin: CallerOrigin;
};

/** A caller whose origin is a signed-in person. */
export type PersonCaller = ToolCaller & { origin: Extract<CallerOrigin, { kind: "person" }> };

/** Which callers a tool allows: a signed-in person, or one agent run kind. */
export type AllowedOrigin = "person" | AgentRunKind;

/** Every agent run kind. A tool open to runs allows all of them. */
export const ANY_RUN: ReadonlyArray<AllowedOrigin> = AGENT_RUN_KINDS;

export const personCaller = (input: { userId: UserId; workspaceId: WorkspaceId; via: UserCallSurface }): ToolCaller =>
  ({ workspaceId: input.workspaceId, onBehalfOf: input.userId, origin: { kind: "person", userId: input.userId, via: input.via } });

export const runCaller = (run: AgentRunSpec): ToolCaller =>
  ({ workspaceId: run.workspaceId, onBehalfOf: run.onBehalfOf, origin: { kind: "run", run } });

export const originKind = (caller: ToolCaller): AllowedOrigin =>
  caller.origin.kind === "person" ? "person" : caller.origin.run.kind;

/** The permission that lets this run call the tool, or null when it has none. */
export function findToolPermission(run: AgentRunSpec, tool: DraftToolName): AnyDraftToolPermission | null {
  return run.permissions.find((permission) => permission.tool === tool) ?? null;
}
