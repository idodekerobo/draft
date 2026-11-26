import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ACTIVE_AGENT_RUN_STATUSES, AGENT_RUN_KINDS, AGENT_RUN_SYSTEM_REASONS, executionProblem, isNativeTool, parseAgentEventId, parseAgentRunId, parseContextVersionId, parseHostId, parseInstructionFileId, parseIsoTimestamp, parseScheduledTaskId, parseSkillId, parseConnectionId, parseUserId, parseWorkspaceId, type AgentRunKind, type AgentRunSpec } from "draft-core/run-spec";
import { callerRun, DRAFT_TOOLS, type AnyDraftToolPermission } from "draft-core/tools";
import { isAdapterId, isHarnessId, type AdapterId, type HarnessId } from "draft-core/harnesses";
import { recordError } from "../../errors/record-error";
import { allowOncePer } from "../../errors/throttle";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../../observability/record-query-log";
import type { AgentRunRow } from "../../types/tables";
import type { ToolCallRecord } from "../tools/invoke-tool";

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), scheduledTaskId: z.string().transform(parseScheduledTaskId), occurrenceAt: z.string().transform(parseIsoTimestamp) }),
  z.object({ type: z.literal("webhook"), provider: z.enum(["slack", "github", "linear", "fireflies", "granola"]), eventId: z.string().min(1) }),
  z.object({ type: z.literal("event"), eventIds: z.array(z.string().transform(parseAgentEventId)) }),
  z.object({ type: z.literal("system"), reason: z.enum(AGENT_RUN_SYSTEM_REASONS) }),
  z.object({ type: z.literal("manual"), requestedBy: z.string().transform(parseUserId) }),
  z.object({ type: z.literal("retry"), retryOf: z.string().transform(parseAgentRunId) }),
  z.object({ type: z.literal("step"), parentRunId: z.string().transform(parseAgentRunId), parentKind: z.enum(["synthesis", "routine"]) }),
]);

const nativeToolSchema = z
  .object({ harness: z.string().refine(isHarnessId), tool: z.string() })
  .refine((permission) => isNativeTool(permission.harness, permission.tool), "unknown built-in tool for this harness")
  .transform((permission) => permission as { harness: HarnessId; tool: string });

const toolsetSchema = z.object({
  nativeTools: z.array(nativeToolSchema),
  mcpServers: z.array(
    z.object({
      connectionId: z.string().transform(parseConnectionId),
      tools: z.union([z.literal("all"), z.array(z.string())]),
    }),
  ),
  skills: z.array(z.string().transform(parseSkillId)),
  instructions: z.array(z.string().transform(parseInstructionFileId)),
});

const executionSchema = z.object({
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("host"), hostId: z.string().transform(parseHostId) }),
    z.object({ type: z.literal("sandbox") }),
    z.object({ type: z.literal("backend"), packageVersion: z.string().min(1) }),
  ]),
  adapterId: z.string().refine(isAdapterId, "unknown adapter").transform((id) => id as AdapterId),
});

const computerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host_computer"), computerId: z.string().min(1), workingDirectory: z.string() }),
  z.object({ type: z.literal("sandbox"), profileId: z.string().min(1), workingDirectory: z.string().min(1), network: z.enum(["open", "restricted"]) }),
  z.object({ type: z.literal("none") }),
]);

const continuationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("native"), nativeSessionId: z.string().min(1) }),
  z.object({ type: z.literal("durable"), storageId: z.string().min(1), conversationId: z.number().int() }),
]);

/** Refuses a spec whose target, adapter and computer cannot go together, before it is saved. */
function assertExecution(spec: AgentRunSpec): void {
  const problem = executionProblem(spec);
  if (problem) throw new Error(`Invalid run execution: ${problem}`);
}

const toolNames = DRAFT_TOOLS.map((tool) => tool.name) as [string, ...string[]];
const permissionSchema = z.object({
  tool: z.enum(toolNames),
  provider: z.string().optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
});

const outputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("structured"), schema: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("none") }),
]);

export interface NewAgentRun {
  spec: AgentRunSpec;
  idempotencyKey: string;
  status?: AgentRunRow["status"];
  attempt?: number;
  promptVersion?: string;
  sessionId?: string;
  scheduledTaskId?: string;
  /** For a step run: the run it belongs to, and which step it is. */
  parentRunId?: string;
  stepKey?: string;
  /** For a step run: what it works on. */
  stepItem?: Record<string, unknown>;
  /** For a step run that retries a failed one. Other runs name this through a `retry` trigger. */
  retryOfRunId?: string;
}

/** Saves the run and its spec. The spec is read back from this row by `loadActiveAgentRunSpec`. */
export async function createAgentRun(client: SupabaseClient, run: NewAgentRun): Promise<void> {
  const { spec } = run;
  assertExecution(spec);
  const { error } = await client.from("agent_runs").insert({
    id: spec.id,
    workspace_id: spec.workspaceId,
    kind: spec.kind,
    trigger: spec.trigger,
    on_behalf_of_user_id: spec.onBehalfOf,
    execution: spec.execution,
    toolset: spec.toolset,
    computer: spec.computer,
    continuation: spec.continuation ?? null,
    harness: spec.harness,
    model: spec.model,
    reasoning_effort: spec.reasoningEffort ?? null,
    instructions: spec.instructions,
    base_context_version_id: spec.inputs.contextVersionId,
    permissions: spec.permissions,
    output: spec.output,
    status: run.status ?? "queued",
    attempt: run.attempt ?? 1,
    retry_of_run_id: spec.trigger.type === "retry" ? spec.trigger.retryOf : run.retryOfRunId ?? null,
    parent_run_id: run.parentRunId ?? null,
    step_key: run.stepKey ?? null,
    step_item: run.stepItem ?? null,
    idempotency_key: run.idempotencyKey,
    prompt_version: run.promptVersion ?? null,
    session_id: run.sessionId ?? null,
    scheduled_task_id: run.scheduledTaskId ?? null,
  });
  if (error) throw error;
}

/**
 * Saves the parts of a spec a run's creator did not know yet. A synthesis run's row is made when the run
 * is prepared; the launcher then says what the run may use and what it must return.
 */
export async function saveAgentRunSpec(client: SupabaseClient, spec: AgentRunSpec): Promise<void> {
  assertExecution(spec);
  const { error } = await client
    .from("agent_runs")
    .update({
      execution: spec.execution,
      toolset: spec.toolset,
      computer: spec.computer,
      continuation: spec.continuation ?? null,
      harness: spec.harness,
      model: spec.model,
      reasoning_effort: spec.reasoningEffort ?? null,
      instructions: spec.instructions,
      permissions: spec.permissions,
      output: spec.output,
    })
    .eq("id", spec.id);
  if (error) throw error;
}

/** Turns a saved row back into the spec. Throws if the row holds something the spec does not allow. */
export function specFromRow(row: AgentRunRow): AgentRunSpec {
  if (!(AGENT_RUN_KINDS as ReadonlyArray<string>).includes(row.kind)) throw new Error(`Unknown run kind: ${row.kind}`);
  // pi runs Home in Draft's backend and is not a harness a person can pick, so it has no HarnessId.
  if (!isHarnessId(row.harness) && row.harness !== "pi") throw new Error(`Unknown harness: ${row.harness}`);
  const continuation = row.continuation == null ? undefined : continuationSchema.parse(row.continuation);
  return {
    id: parseAgentRunId(row.id),
    kind: row.kind as AgentRunKind,
    workspaceId: parseWorkspaceId(row.workspace_id),
    trigger: triggerSchema.parse(row.trigger),
    onBehalfOf: row.on_behalf_of_user_id ? parseUserId(row.on_behalf_of_user_id) : null,
    execution: executionSchema.parse(row.execution),
    toolset: toolsetSchema.parse(row.toolset),
    computer: computerSchema.parse(row.computer),
    ...(continuation ? { continuation } : {}),
    harness: row.harness as HarnessId,
    model: row.model,
    reasoningEffort: row.reasoning_effort ?? null,
    instructions: row.instructions,
    inputs: { contextVersionId: parseContextVersionId(row.base_context_version_id) },
    permissions: z.array(permissionSchema).parse(row.permissions) as unknown as AnyDraftToolPermission[],
    output: outputSchema.parse(row.output) as AgentRunSpec["output"],
  };
}

/** The spec of a run that has not finished. A finished run's token no longer opens the gateway. */
export async function loadActiveAgentRunSpec(client: SupabaseClient, runId: string): Promise<AgentRunSpec | null> {
  const { data, error } = await client.from("agent_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  const row = data as AgentRunRow | null;
  if (!row || !(ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(row.status)) return null;
  return specFromRow(row);
}

/**
 * Saves the audit row for a call. A run's calls go to agent_run_tool_calls. A person's calls go to the
 * agent query log, as before, but only when they came in through an agent surface.
 */
export function auditToDatabase(client: SupabaseClient, sessionId?: string): (record: ToolCallRecord) => Promise<void> {
  const write = writeAudit(client, sessionId);
  return async (record) => {
    try {
      await write(record);
    } catch (error) {
      // The caller still logs and ignores this, so the failure is recorded here, once a minute per tool.
      if (allowOncePer(`audit:${record.toolName}`, AUDIT_ERROR_WINDOW_MS)) {
        await recordError({ client, workspaceId: record.caller.workspaceId, agentRunId: callerRun(record.caller)?.id ?? null, operation: "audit", code: "tool_audit_failed", message: "A tool call's audit row could not be saved", detail: { tool: record.toolName }, error });
      }
      throw error;
    }
  };
}

const AUDIT_ERROR_WINDOW_MS = 60_000;

function writeAudit(client: SupabaseClient, sessionId?: string): (record: ToolCallRecord) => Promise<void> {
  return async (record) => {
    const { origin } = record.caller;
    const run = callerRun(record.caller);
    if (origin.kind === "person" && !run) {
      if (origin.via !== "cli" && origin.via !== "mcp") return;
      const command = origin.via === "mcp" ? `mcp.${record.toolName}` : record.toolName;
      await recordAgentQueryLog(client, {
        workspaceId: record.caller.workspaceId,
        userId: origin.userId,
        command: command as AgentQueryLogCommand,
        argsJson: record.arguments,
        resultBytes: record.resultBytes,
        surface: origin.via,
        sessionId,
        status: record.status,
        durationMs: record.durationMs,
        errorCode: record.errorCode,
      });
      return;
    }
    if (!run) return;
    const { error } = await client.from("agent_run_tool_calls").insert({
      workspace_id: run.workspaceId,
      agent_run_id: run.id,
      tool_name: record.toolName,
      arguments: record.arguments,
      status: record.status,
      result_summary: record.resultSummary,
      error_code: record.errorCode,
      duration_ms: record.durationMs,
    });
    if (error) throw error;
  };
}
