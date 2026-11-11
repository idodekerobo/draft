/**
 * The tools Draft's gateway serves, what a person may limit on them, and who may call them.
 */
import type { AgentRunSpec, PersonId, UserId, WorkspaceId } from "./run-spec";

/** Every tool the Draft gateway can serve. Adding a tool starts here. */
export const DRAFT_TOOLS = [
  { name: "context.read", access: "read" },
  { name: "context.write", access: "write" },
  { name: "context.list", access: "read" },
  { name: "context.export", access: "read" },
  { name: "sources.search", access: "read" },
  { name: "sources.read", access: "read" },
  { name: "skills.list", access: "read" },
  { name: "skills.read", access: "read" },
  { name: "skills.add", access: "write" },
  { name: "skills.update", access: "write" },
  { name: "skills.delete", access: "write" },
  { name: "routines.list", access: "read" },
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
  "sources.read": Record<string, never>;
  "skills.list": Record<string, never>;
  "skills.read": Record<string, never>;
  "skills.add": Record<string, never>;
  "skills.update": Record<string, never>;
  "skills.delete": Record<string, never>;
  "routines.list": Record<string, never>;
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

/** What a synthesis run may do: read and write context, and note new teammates. It can never message anyone. */
export const SYNTHESIS_PERMISSIONS: ReadonlyArray<AnyDraftToolPermission> = [
  ...CONTEXT_READ_WRITE_PERMISSIONS,
  { tool: "people.find" },
  { tool: "people.create", limits: { maxPerRun: 5 } },
  { tool: "people.add_identity", limits: { maxPerRun: 10 } },
];

/** Where a person's call came in: an MCP client, the CLI, or Draft's own app. Only the first two are logged as agent queries. */
export type UserCallSurface = "mcp" | "cli" | "app";

/** Who is calling a tool. Each surface proves this its own way, then hands the gateway this value. */
export type ToolCaller =
  | { type: "run"; run: AgentRunSpec }
  | { type: "user"; userId: UserId; workspaceId: WorkspaceId; via: UserCallSurface };

/** The permission that lets this run call the tool, or null when it has none. */
export function findToolPermission(run: AgentRunSpec, tool: DraftToolName): AnyDraftToolPermission | null {
  return run.permissions.find((permission) => permission.tool === tool) ?? null;
}
