import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AGENT_RUN_KINDS,
  AGENT_RUN_SYSTEM_REASONS,
  CLAUDE_NATIVE_TOOLS,
  CODEX_NATIVE_TOOLS,
  DRAFT_TOOLS,
  parseAgentRunId,
  parseContextVersionId,
  parseHostMachineId,
  parseInstructionFileId,
  parseIsoTimestamp,
  parseScheduledTaskId,
  parseSkillId,
  parseSourceConnectionId,
  parseUserId,
  parseWorkspaceId,
  type AgentRunKind,
  type AgentRunSpec,
  type AnyDraftToolPermission,
} from "draft-core/agent-run";
import { isHarnessId } from "draft-core/harnesses";
import { isLoggedCommand } from "../observability/logged-commands";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../observability/record-query-log";
import type { AgentRunRow } from "../types/tables";
import type { ToolCallRecord } from "./invoke-tool";

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), scheduledTaskId: z.string().transform(parseScheduledTaskId), occurrenceAt: z.string().transform(parseIsoTimestamp) }),
  z.object({ type: z.literal("webhook"), provider: z.enum(["slack", "github", "linear", "fireflies", "granola"]), eventId: z.string().min(1) }),
  z.object({ type: z.literal("system"), reason: z.enum(AGENT_RUN_SYSTEM_REASONS) }),
  z.object({ type: z.literal("manual"), requestedBy: z.string().transform(parseUserId) }),
  z.object({ type: z.literal("retry"), retryOf: z.string().transform(parseAgentRunId) }),
]);

const principalSchema = z.object({ type: z.literal("workspace") });

const nativeToolSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("claude"), tool: z.enum(CLAUDE_NATIVE_TOOLS) }),
  z.object({ harness: z.literal("codex"), tool: z.enum(CODEX_NATIVE_TOOLS) }),
]);

const environmentSchema = z.object({
  nativeTools: z.array(nativeToolSchema),
  mcpServers: z.array(
    z.object({
      connectionId: z.string().transform(parseSourceConnectionId),
      tools: z.union([z.literal("all"), z.array(z.string())]),
    }),
  ),
  skills: z.array(z.string().transform(parseSkillId)),
  instructions: z.array(z.string().transform(parseInstructionFileId)),
});

const runtimeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), hostMachineId: z.string().transform(parseHostMachineId) }),
  z.object({ type: z.literal("cloud"), environment: environmentSchema }),
]);

const toolNames = DRAFT_TOOLS.map((tool) => tool.name) as [string, ...string[]];
const permissionSchema = z.object({
  tool: z.enum(toolNames),
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
}

/** Saves the run and its spec. The spec is read back from this row by `loadActiveAgentRunSpec`. */
export async function createAgentRun(client: SupabaseClient, run: NewAgentRun): Promise<void> {
  const { spec } = run;
  const { error } = await client.from("agent_runs").insert({
    id: spec.id,
    workspace_id: spec.workspaceId,
    kind: spec.kind,
    trigger: spec.trigger,
    principal: spec.principal,
    runtime: spec.runtime,
    harness: spec.harness,
    model: spec.model,
    instructions: spec.instructions,
    base_context_version_id: spec.inputs.contextVersionId,
    permissions: spec.permissions,
    output: spec.output,
    status: run.status ?? "queued",
    attempt: run.attempt ?? 1,
    retry_of_run_id: spec.trigger.type === "retry" ? spec.trigger.retryOf : null,
    idempotency_key: run.idempotencyKey,
    prompt_version: run.promptVersion ?? null,
    session_id: run.sessionId ?? null,
  });
  if (error) throw error;
}

/**
 * Saves the parts of a spec a run's creator did not know yet. A synthesis run's row is made by a trigger
 * when the run is prepared; the launcher then says what the run may use and what it must return.
 */
export async function saveAgentRunSpec(client: SupabaseClient, spec: AgentRunSpec): Promise<void> {
  const { error } = await client
    .from("agent_runs")
    .update({
      runtime: spec.runtime,
      harness: spec.harness,
      model: spec.model,
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
  if (!isHarnessId(row.harness)) throw new Error(`Unknown harness: ${row.harness}`);
  return {
    id: parseAgentRunId(row.id),
    kind: row.kind as AgentRunKind,
    workspaceId: parseWorkspaceId(row.workspace_id),
    trigger: triggerSchema.parse(row.trigger),
    principal: principalSchema.parse(row.principal),
    runtime: runtimeSchema.parse(row.runtime),
    harness: row.harness,
    model: row.model,
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
export function auditToDatabase(client: SupabaseClient): (record: ToolCallRecord) => Promise<void> {
  return async (record) => {
    if (record.caller.type === "user") {
      if (record.caller.via === "app") return;
      const command = record.caller.via === "mcp" ? `mcp.${record.toolName}` : record.toolName;
      if (!isLoggedCommand(command)) return;
      await recordAgentQueryLog(client, {
        workspaceId: record.caller.workspaceId,
        userId: record.caller.userId,
        command: command as AgentQueryLogCommand,
        argsJson: record.arguments,
        resultBytes: record.resultBytes,
      });
      return;
    }
    const { run } = record.caller;
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
