import { findToolPermission, isDraftToolName, type ToolCaller } from "draft-core/agent-run";
import type { ToolRegistry } from "./tool-registry";

export type ToolCallStatus = "ok" | "denied" | "invalid" | "conflict" | "error";

export type InvokeToolResult =
  | { status: "ok"; output: unknown }
  | { status: "conflict"; output: unknown }
  | { status: "denied"; code: ToolDenialCode; message: string }
  | { status: "invalid"; issues: string[] }
  | { status: "error"; message: string };

export type ToolDenialCode = "unknown_tool" | "not_permitted" | "outside_limits" | "caller_not_authorized";

/** One row of audit for a call a run made. Written for every outcome. */
export interface ToolCallRecord {
  run: Extract<ToolCaller, { type: "run" }>["run"];
  toolName: string;
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
  /** Decides if a signed-in person may call a tool. Without it, person callers are denied. */
  authorizeUser?: (caller: Extract<ToolCaller, { type: "user" }>, toolName: string) => Promise<boolean>;
  now?: () => number;
}

const MAX_AUDITED_ARGUMENT_BYTES = 10_000;

function auditable(value: unknown): Record<string, unknown> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  const bytes = Buffer.byteLength(JSON.stringify(record) ?? "");
  return bytes > MAX_AUDITED_ARGUMENT_BYTES ? { truncated: true, bytes } : record;
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
    if (caller.type === "run") {
      try {
        await deps.audit({
          run: caller.run,
          toolName,
          arguments: auditable(audited.arguments),
          status: result.status,
          resultSummary: audited.summary ?? null,
          errorCode: audited.code ?? null,
          durationMs: Math.max(0, now() - startedAt),
        });
      } catch (error) {
        console.error(JSON.stringify({ source: "invoke_tool", event: "audit_failed", tool: toolName, runId: caller.run.id, error: String(error) }));
      }
    }
    return result;
  };

  const deny = (code: ToolDenialCode, message: string) =>
    finish({ status: "denied", code, message }, { arguments: rawArguments, code });

  const tool = deps.registry.get(toolName);
  if (!tool || !isDraftToolName(toolName)) return deny("unknown_tool", `Unknown tool: ${toolName}`);

  let limits: unknown;
  if (caller.type === "run") {
    const permission = findToolPermission(caller.run, toolName);
    if (!permission) return deny("not_permitted", `This run may not call ${toolName}`);
    limits = permission.limits;
  } else if (!(await deps.authorizeUser?.(caller, toolName))) {
    return deny("caller_not_authorized", `Not allowed to call ${toolName}`);
  }

  const parsed = tool.parse(rawArguments);
  if (!parsed.ok) {
    return finish({ status: "invalid", issues: parsed.issues }, { arguments: rawArguments, summary: parsed.issues.join("; ") });
  }

  const limitReason = tool.checkLimits(limits, parsed.value);
  if (limitReason) return finish({ status: "denied", code: "outside_limits", message: limitReason }, { arguments: tool.auditArguments(parsed.value), code: "outside_limits", summary: limitReason });

  try {
    const result = await tool.run(caller, parsed.value);
    return finish(
      { status: result.status, output: result.output },
      { arguments: tool.auditArguments(parsed.value), summary: result.summary ?? null },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The agent gets a generic message. The real one stays in the audit row.
    return finish(
      { status: "error", message: "The tool failed. Try again, or report the problem." },
      { arguments: tool.auditArguments(parsed.value), summary: message, code: "handler_error" },
    );
  }
}
