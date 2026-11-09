import type { z } from "zod";
import {
  DRAFT_TOOLS,
  findToolPermission,
  type AgentRunSpec,
  type DraftToolAccess,
  type DraftToolLimits,
  type DraftToolName,
  type ToolCaller,
} from "draft-core/agent-run";

export interface ToolContext<I> {
  input: I;
  caller: ToolCaller;
}

/** A handler returns "conflict" when the caller must change its request and try again. */
export type ToolHandlerResult =
  | { status: "ok"; output: unknown; summary?: string }
  | { status: "conflict"; output: unknown; summary?: string };

/** What a tool author writes. The handler sees its input already parsed. */
export interface ToolSpec<N extends DraftToolName, S extends z.ZodType> {
  name: N;
  description: string;
  /** Who may call it. Omitted means both. A tool that needs a person's identity says "user" only. */
  callers?: ReadonlyArray<ToolCaller["type"]>;
  input: S;
  /** Returns a reason when the input is outside the run's limits for this tool, or null when it is inside. */
  checkLimits?: (limits: DraftToolLimits[N] | undefined, input: z.output<S>) => string | null;
  /** What the audit row stores for this call. The default is the input as received. */
  auditArguments?: (input: z.output<S>) => Record<string, unknown>;
  handler: (context: ToolContext<z.output<S>>) => Promise<ToolHandlerResult>;
}

/** An error whose message is meant for the agent that called the tool, such as a refusal from a remote server. */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUserError";
  }
}

/** The permission a run holds for a tool, with its limits, or null when it holds none. */
export type RunPermission = { limits?: unknown } | null;

/** A tool as the registry holds it. Parsing and limit checks are bound to the right types already. */
export interface RegisteredTool {
  /** A Draft tool name, or for a remote server's tool a name the gateway made up. */
  name: string;
  access: DraftToolAccess;
  description: string;
  callers: ReadonlyArray<ToolCaller["type"]>;
  inputSchema: z.ZodType;
  /** Null when the input is valid and inside the limits, otherwise the reason. Parsing errors are reported by `parse`. */
  parse: (raw: unknown) => { ok: true; value: unknown } | { ok: false; issues: string[] };
  /** How a run comes to hold this tool. Draft's own tools come from the run's permissions. */
  permission: (run: AgentRunSpec) => RunPermission;
  checkLimits: (limits: unknown, value: unknown) => string | null;
  auditArguments: (value: unknown) => Record<string, unknown>;
  run: (caller: ToolCaller, value: unknown) => Promise<ToolHandlerResult>;
}

/** `access` is read from the core list of tools, so it is stated once. */
export function defineTool<N extends DraftToolName, S extends z.ZodType>(spec: ToolSpec<N, S>): RegisteredTool {
  const entry = DRAFT_TOOLS.find((tool) => tool.name === spec.name);
  if (!entry) throw new Error(`Unknown Draft tool: ${spec.name}`);
  return {
    name: spec.name,
    access: entry.access,
    description: spec.description,
    callers: spec.callers ?? ["run", "user"],
    inputSchema: spec.input,
    permission: (run) => findToolPermission(run, spec.name),
    parse(raw) {
      const result = spec.input.safeParse(raw);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, issues: result.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`) };
    },
    // The gateway only passes limits it found under this tool's name and a value this tool parsed.
    checkLimits: (limits, value) =>
      spec.checkLimits ? spec.checkLimits(limits as DraftToolLimits[N] | undefined, value as z.output<S>) : null,
    auditArguments: (value) =>
      spec.auditArguments ? spec.auditArguments(value as z.output<S>) : (value as Record<string, unknown>),
    run: (caller, value) => spec.handler({ input: value as z.output<S>, caller }),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(definitions: ReadonlyArray<RegisteredTool>) {
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) throw new Error(`Tool registered twice: ${definition.name}`);
      this.tools.set(definition.name, definition);
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ReadonlyArray<RegisteredTool> {
    return [...this.tools.values()];
  }

  /** The tools this run may call. A run never sees the others. */
  listFor(run: AgentRunSpec): ReadonlyArray<RegisteredTool> {
    return this.list().filter((tool) => tool.callers.includes("run") && tool.permission(run) !== null);
  }

  /** The same tools plus these. Used per request, for the tools a run reaches through a connection. */
  extendedWith(extra: ReadonlyArray<RegisteredTool>): ToolRegistry {
    return new ToolRegistry([...this.list(), ...extra]);
  }

  /** The tools a signed-in person may call. */
  listForUser(): ReadonlyArray<RegisteredTool> {
    return this.list().filter((tool) => tool.callers.includes("user"));
  }
}
