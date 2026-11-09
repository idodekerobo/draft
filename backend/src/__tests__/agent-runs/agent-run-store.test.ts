import { describe, expect, it } from "bun:test";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseIsoTimestamp,
  parseScheduledTaskId,
  parseSourceConnectionId,
  parseUserId,
  parseWorkspaceId,
  type AgentRunSpec,
} from "draft-core/agent-run";
import { auditToDatabase, createAgentRun, specFromRow } from "../../agent-runs/agent-run-store";
import type { ToolCallRecord } from "../../agent-runs/invoke-tool";
import type { AgentRunRow } from "../../types/tables";

const spec: AgentRunSpec = {
  id: parseAgentRunId("11111111-1111-4111-8111-111111111111"),
  kind: "routine",
  workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
  trigger: {
    type: "cron",
    scheduledTaskId: parseScheduledTaskId("55555555-5555-4555-8555-555555555555"),
    occurrenceAt: parseIsoTimestamp("2026-11-09T09:00:00.000Z"),
  },
  principal: { type: "workspace" },
  runtime: {
    type: "cloud",
    environment: {
      nativeTools: [{ harness: "claude", tool: "WebSearch" }],
      mcpServers: [{ connectionId: parseSourceConnectionId("66666666-6666-4666-8666-666666666666"), tools: ["search"] }],
      skills: [],
      instructions: [],
    },
  },
  harness: "codex",
  model: "gpt-6-sol",
  instructions: "summarize the week",
  inputs: { contextVersionId: parseContextVersionId("44444444-4444-4444-8444-444444444444") },
  permissions: [{ tool: "context.write", limits: { pathPrefixes: ["memory/"] } }, { tool: "context.read" }],
  output: { type: "structured", schema: { type: "object" } },
};

function fakeClient() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: null };
      },
    }),
  };
  return { client: client as never, inserts };
}

function rowFrom(insert: Record<string, unknown>): AgentRunRow {
  return { ...insert, summary: null, failure_code: null, failure_detail: null, started_at: null, completed_at: null, created_at: "", updated_at: "", sandbox_machine_id: null } as unknown as AgentRunRow;
}

describe("agent run store", () => {
  it("saves a spec and reads the same spec back from the row", async () => {
    const { client, inserts } = fakeClient();
    await createAgentRun(client, { spec, idempotencyKey: "k1", promptVersion: "routine-v1" });
    expect(inserts[0].table).toBe("agent_runs");
    expect(inserts[0].row).toMatchObject({ id: spec.id, kind: "routine", base_context_version_id: spec.inputs.contextVersionId, status: "queued", attempt: 1 });
    expect(specFromRow(rowFrom(inserts[0].row))).toEqual(spec);
  });

  it("stores the original run id of a retry", async () => {
    const { client, inserts } = fakeClient();
    const original = parseAgentRunId("77777777-7777-4777-8777-777777777777");
    await createAgentRun(client, { spec: { ...spec, trigger: { type: "retry", retryOf: original } }, idempotencyKey: "retry:7" });
    expect(inserts[0].row.retry_of_run_id).toBe(original);
  });

  it("reads the run a synthesis run was mirrored as, with a system trigger", () => {
    const mirrored = rowFrom({
      id: spec.id, workspace_id: spec.workspaceId, kind: "synthesis", trigger: { type: "system", reason: "source_threshold" }, principal: spec.principal,
      runtime: spec.runtime, harness: "claude", model: null, instructions: "", base_context_version_id: spec.inputs.contextVersionId,
      permissions: [], output: { type: "structured", schema: {} }, status: "succeeded", attempt: 1, retry_of_run_id: null, idempotency_key: "k", prompt_version: "synthesis-v1", session_id: null,
    });
    expect(specFromRow(mirrored)).toMatchObject({ kind: "synthesis", trigger: { type: "system", reason: "source_threshold" }, permissions: [] });
  });

  it("rejects rows that do not match the spec", () => {
    const good = rowFrom({
      id: spec.id, workspace_id: spec.workspaceId, kind: "routine", trigger: spec.trigger, principal: spec.principal,
      runtime: spec.runtime, harness: "codex", model: null, instructions: "", base_context_version_id: spec.inputs.contextVersionId,
      permissions: [], output: spec.output, status: "queued", attempt: 1, retry_of_run_id: null, idempotency_key: "k", prompt_version: null, session_id: null,
    });
    expect(() => specFromRow({ ...good, harness: "unknown-harness" })).toThrow("Unknown harness");
    expect(() => specFromRow({ ...good, kind: "mystery" as never })).toThrow("Unknown run kind");
    expect(() => specFromRow({ ...good, permissions: [{ tool: "slack.post_message" }] })).toThrow();
    expect(() => specFromRow({ ...good, trigger: { type: "manual", requestedBy: "nope" } })).toThrow();
    expect(() => specFromRow({ ...good, trigger: { type: "system", reason: "because" } })).toThrow();
    expect(() => specFromRow({ ...good, runtime: { type: "local", hostMachineId: "" } })).toThrow();
  });
});

describe("audit rows", () => {
  const base = { toolName: "context.read", arguments: { dimensions: ["memory"] }, status: "ok" as const, resultSummary: null, errorCode: null, durationMs: 3, resultBytes: 42 };
  const user = (via: "mcp" | "cli" | "app") => ({
    type: "user" as const,
    userId: parseUserId("33333333-3333-4333-8333-333333333333"),
    workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
    via,
  });

  it("writes a person's MCP call to the agent query log under the mcp command name", async () => {
    const { client, inserts } = fakeClient();
    await auditToDatabase(client)({ ...base, caller: user("mcp") } as ToolCallRecord);
    expect(inserts).toEqual([
      { table: "agent_query_log", row: { workspace_id: "22222222-2222-4222-8222-222222222222", user_id: "33333333-3333-4333-8333-333333333333", command: "mcp.context.read", args_json: { dimensions: ["memory"] }, result_bytes: 42 } },
    ]);
  });

  it("uses the plain command name for the CLI and writes nothing for the app", async () => {
    const cli = fakeClient();
    await auditToDatabase(cli.client)({ ...base, caller: user("cli") } as ToolCallRecord);
    expect(cli.inserts[0]!.row.command).toBe("context.read");
    const app = fakeClient();
    await auditToDatabase(app.client)({ ...base, caller: user("app") } as ToolCallRecord);
    expect(app.inserts).toEqual([]);
  });

  it("writes a run's call to its own table", async () => {
    const { client, inserts } = fakeClient();
    await auditToDatabase(client)({ ...base, caller: { type: "run", run: spec } } as ToolCallRecord);
    expect(inserts[0]).toMatchObject({ table: "agent_run_tool_calls", row: { agent_run_id: spec.id, tool_name: "context.read", status: "ok", duration_ms: 3 } });
  });
});
