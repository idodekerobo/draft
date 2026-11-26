import { originKind, type PersonCaller, type ToolCaller } from "draft-core/tools";
import { describeError } from "../../errors/describe-error";
import { ToolUserError, type ToolRegistry } from "./tool-registry";

export type InvokeToolResult =
  | { status: "ok"; output: unknown }
  | { status: "conflict"; output: unknown }
  | { status: "refused"; code: string; message: string }
  | { status: "denied"; code: ToolDenialCode; message: string; detail?: AuthorizationDenial }
  | { status: "invalid"; issues: string[] }
  | { status: "error"; message: string };

export type ToolCallStatus = InvokeToolResult["status"];

export type ToolDenialCode = "unknown_tool" | "not_permitted" | "outside_limits" | "caller_not_authorized";

/** What an edge may want to tell its client when a person is refused. */
export interface AuthorizationDenial {
  status: number;
  body: unknown;
}

/** One row of audit for a call, written for every outcome. */
export interface ToolCallRecord {
  caller: ToolCaller;
  toolName: string;
  resultBytes: number;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  resultSummary: string | null;
  errorCode: string | null;
  durationMs: number;
}

export interface InvokeToolDeps {
  registry: ToolRegistry;
  /** Saves the audit row. A failure here is logged and never changes the result of the call. */
  audit: (record: ToolCallRecord) => Promise<void>;
  /** Decides if a signed-in person may call a tool: null lets the call through, anything else refuses it. Without it, person callers are denied. */
  authorizeUser?: (caller: PersonCaller, toolName: string) => Promise<AuthorizationDenial | null>;
  now?: () => number;
}

const MAX_AUDITED_ARGUMENT_BYTES = 10_000;

function auditable(value: unknown): Record<string, unknown> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  const redact = (value: unknown, depth = 0): unknown => {
    if (depth > 8) return { truncated: true };
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value).filter(([key]) => !/(?:password|secret|token|credential|authorization|api.?key|auth_json|prompt|content|message|body|text|title|instructions)/i.test(key))
        .map(([key, item]) => [key, redact(item, depth + 1)]),
    );
    return value;
  };
  const safe = redact(record) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(safe) ?? "");
  return bytes > MAX_AUDITED_ARGUMENT_BYTES ? { truncated: true, bytes } : safe;
}

/**
 * The one door every tool call goes through, whichever surface it came in on.
 * Each surface proves who is calling and passes a ToolCaller. The checks and the audit are here.
 */
export async function invokeTool(
  deps: InvokeToolDeps,
  caller: ToolCaller,
  toolName: string,
  rawArguments: unknown,
): Promise<InvokeToolResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const finish = async (
    result: InvokeToolResult,
    audited: { arguments: unknown; summary?: string | null; code?: string | null },
  ): Promise<InvokeToolResult> => {
    try {
      await deps.audit({
        caller,
        toolName,
        arguments: auditable(audited.arguments),
        status: result.status,
        resultSummary: audited.summary ?? null,
        errorCode: audited.code ?? null,
        durationMs: Math.max(0, now() - startedAt),
        resultBytes: "output" in result ? Buffer.byteLength(JSON.stringify(result.output) ?? "") : 0,
      });
    } catch (error) {
      console.error(JSON.stringify({ source: "invoke_tool", event: "audit_failed", tool: toolName, caller: originKind(caller), error: String(error) }));
    }
    return result;
  };

  const deny = (code: ToolDenialCode, message: string, detail?: AuthorizationDenial) =>
    finish({ status: "denied", code, message, ...(detail ? { detail } : {}) }, { arguments: {}, code });

  const tool = deps.registry.get(toolName);
  if (!tool) return deny("unknown_tool", `Unknown tool: ${toolName}`);

  if (!tool.allowedOrigins.includes(originKind(caller))) return deny("caller_not_authorized", `${toolName} is not available to this kind of caller`);

  let limits: unknown;
  const { origin } = caller;
  if (origin.kind === "run") {
    const permission = tool.permission(origin.run);
    if (!permission) return deny("not_permitted", `This run may not call ${toolName}`);
    limits = permission.limits;
  } else {
    const person: PersonCaller = { ...caller, origin };
    const refusal = deps.authorizeUser ? await deps.authorizeUser(person, toolName) : { status: 403, body: { error: "forbidden" } };
    if (refusal) return deny("caller_not_authorized", `Not allowed to call ${toolName}`, refusal);
    // An owner-run caller keeps the owner's authority, and the limits its run was given for this tool still apply.
    if (origin.run) limits = tool.permission(origin.run)?.limits;
  }

  const parsed = tool.parse(rawArguments);
  if (!parsed.ok) {
    return finish({ status: "invalid", issues: parsed.issues }, { arguments: {}, code: "invalid_arguments" });
  }

  if (origin.kind === "run" && tool.providerOf) {
    const grant = tool.permission(origin.run, parsed.value);
    if (!grant) return deny("not_permitted", `This run may not call ${toolName} for ${tool.providerOf(parsed.value) ?? "that provider"}`);
    limits = grant.limits;
  }

  const limitReason = tool.checkLimits(limits, parsed.value);
  if (limitReason) return finish({ status: "denied", code: "outside_limits", message: limitReason }, { arguments: tool.auditArguments(parsed.value), code: "outside_limits", summary: limitReason });

  try {
    const result = await tool.run(caller, parsed.value);
    if (result.status === "refused") {
      return finish({ status: "refused", code: result.code, message: result.message }, { arguments: tool.auditArguments(parsed.value), summary: result.message, code: result.code });
    }
    return finish(
      { status: result.status, output: result.output },
      { arguments: tool.auditArguments(parsed.value), summary: result.summary ?? null },
    );
  } catch (error) {
    const message = describeError(error);
    // The agent gets a generic message unless the tool meant it to see this one. The real one stays in the audit row.
    const visible = error instanceof ToolUserError ? message : "The tool failed. Try again, or report the problem.";
    return finish(
      { status: "error", message: visible },
      { arguments: tool.auditArguments(parsed.value), summary: message, code: "handler_error" },
    );
  }
}
