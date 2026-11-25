import { describe, expect, it } from "bun:test";
import { SANDBOX_RUN_DIRECTORY, parseAgentEventId, sandboxComputer, sandboxExecution, parseAgentRunId, parseContextVersionId, parseIsoTimestamp, parseScheduledTaskId, parseConnectionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller } from "draft-core/tools";
import { auditToDatabase, createAgentRun, specFromRow } from "../../../metaharness/runs/agent-run-store";
import type { ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import type { AgentRunRow } from "../../../types/tables";

const spec: AgentRunSpec = {
  id: parseAgentRunId("11111111-1111-4111-8111-111111111111"),
  kind: "routine",
  workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
  trigger: {
    type: "cron",
    scheduledTaskId: parseScheduledTaskId("55555555-5555-4555-8555-555555555555"),
    occurrenceAt: parseIsoTimestamp("2026-11-09T09:00:00.000Z"),
  },
  onBehalfOf: null,
  execution: sandboxExecution("codex-exec"),
  toolset: {
    nativeTools: [{ harness: "codex", tool: "web_search" }],
    mcpServers: [{ connectionId: parseConnectionId("66666666-6666-4666-8666-666666666666"), tools: ["search"] }],
    skills: [],
    instructions: [],
  },
  computer: sandboxComputer("open", SANDBOX_RUN_DIRECTORY),
  harness: "codex",
  model: "gpt-6-sol",
  reasoningEffort: "ultra",
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

  it("stores the execution, toolset and computer in their own columns, with the network on the computer", async () => {
    const { client, inserts } = fakeClient();
    await createAgentRun(client, { spec, idempotencyKey: "k-columns" });
    expect(inserts[0].row).toMatchObject({
      execution: { target: { type: "sandbox" }, adapterId: "codex-exec" },
      computer: { type: "sandbox", profileId: "default", workingDirectory: SANDBOX_RUN_DIRECTORY, network: "open" },
      continuation: null,
    });
    expect(inserts[0].row.toolset).toEqual(spec.toolset);
    expect(inserts[0].row).not.toHaveProperty("runtime");
  });

  it("round-trips a continuation, and leaves it out of a fresh launch", async () => {
    const { client, inserts } = fakeClient();
    const resumed: AgentRunSpec = { ...spec, continuation: { type: "native", nativeSessionId: "native-1" } };
    await createAgentRun(client, { spec: resumed, idempotencyKey: "k-resume" });
    expect(specFromRow(rowFrom(inserts[0].row))).toEqual(resumed);
    expect(specFromRow(rowFrom(inserts[0].row)).continuation).toEqual({ type: "native", nativeSessionId: "native-1" });
    await createAgentRun(client, { spec, idempotencyKey: "k-fresh" });
    expect("continuation" in specFromRow(rowFrom(inserts[1].row))).toBe(false);
  });

  it("refuses to save a spec whose adapter cannot run on its target", async () => {
    const { client, inserts } = fakeClient();
    await expect(createAgentRun(client, { spec: { ...spec, execution: { target: { type: "sandbox" }, adapterId: "codex-app-server" } }, idempotencyKey: "k-bad" })).rejects.toThrow("cannot run on a sandbox target");
    await expect(createAgentRun(client, { spec: { ...spec, execution: sandboxExecution("claude-print") }, idempotencyKey: "k-bad2" })).rejects.toThrow("does not run harness codex");
    expect(inserts).toEqual([]);
  });

  it("round-trips the user a run acts for, and reads the actor back from the run id", async () => {
    const { client, inserts } = fakeClient();
    const asUser: AgentRunSpec = { ...spec, onBehalfOf: parseUserId("99999999-9999-4999-8999-999999999999") };
    await createAgentRun(client, { spec: asUser, idempotencyKey: "k-user" });
    expect(inserts[0].row.on_behalf_of_user_id).toBe(asUser.onBehalfOf);
    expect(specFromRow(rowFrom(inserts[0].row))).toEqual(asUser);
  });

  it("stores the original run id of a retry", async () => {
    const { client, inserts } = fakeClient();
    const original = parseAgentRunId("77777777-7777-4777-8777-777777777777");
    await createAgentRun(client, { spec: { ...spec, trigger: { type: "retry", retryOf: original } }, idempotencyKey: "retry:7" });
    expect(inserts[0].row.retry_of_run_id).toBe(original);
  });

  it("round-trips the agent events that woke a run", async () => {
    const { client, inserts } = fakeClient();
    const woke: AgentRunSpec = { ...spec, trigger: { type: "event", eventIds: [parseAgentEventId("88888888-8888-4888-8888-888888888888")] } };
    await createAgentRun(client, { spec: woke, idempotencyKey: "event:8" });
    expect(specFromRow(rowFrom(inserts[0].row))).toEqual(woke);
  });

  it("reads the run a synthesis run was mirrored as, with a system trigger", () => {
    const mirrored = rowFrom({
      id: spec.id, workspace_id: spec.workspaceId, kind: "synthesis", trigger: { type: "system", reason: "source_threshold" }, on_behalf_of_user_id: spec.onBehalfOf,
      execution: sandboxExecution("claude-print"), toolset: spec.toolset, computer: spec.computer, continuation: null, harness: "claude", model: null, instructions: "", base_context_version_id: spec.inputs.contextVersionId,
      permissions: [], output: { type: "structured", schema: {} }, status: "succeeded", attempt: 1, retry_of_run_id: null, idempotency_key: "k", prompt_version: "synthesis-v1", session_id: null,
    });
    expect(specFromRow(mirrored)).toMatchObject({ kind: "synthesis", trigger: { type: "system", reason: "source_threshold" }, permissions: [] });
  });

  it("rejects rows that do not match the spec", () => {
    const good = rowFrom({
      id: spec.id, workspace_id: spec.workspaceId, kind: "routine", trigger: spec.trigger, on_behalf_of_user_id: spec.onBehalfOf,
      execution: spec.execution, toolset: spec.toolset, computer: spec.computer, continuation: null, harness: "codex", model: null, instructions: "", base_context_version_id: spec.inputs.contextVersionId,
      permissions: [], output: spec.output, status: "queued", attempt: 1, retry_of_run_id: null, idempotency_key: "k", prompt_version: null, session_id: null,
    });
    expect(() => specFromRow({ ...good, harness: "unknown-harness" })).toThrow("Unknown harness");
    expect(() => specFromRow({ ...good, kind: "mystery" as never })).toThrow("Unknown run kind");
    expect(() => specFromRow({ ...good, permissions: [{ tool: "made.up_tool" }] })).toThrow();
    expect(() => specFromRow({ ...good, permissions: [{ tool: "slack.post_message" }] })).toThrow();
    const perProvider = [{ tool: "connections.post", provider: "slack", limits: { channels: "joined", maxPerRun: 3 } }];
    expect(specFromRow({ ...good, permissions: perProvider }).permissions).toEqual(perProvider as never);
    expect(() => specFromRow({ ...good, trigger: { type: "manual", requestedBy: "nope" } })).toThrow();
    expect(() => specFromRow({ ...good, trigger: { type: "system", reason: "because" } })).toThrow();
    expect(() => specFromRow({ ...good, trigger: { type: "event", eventIds: ["evt_123"] } })).toThrow();
    expect(() => specFromRow({ ...good, execution: { target: { type: "host", hostId: "" }, adapterId: "claude-terminal" } })).toThrow();
    expect(() => specFromRow({ ...good, execution: { target: { type: "sandbox" }, adapterId: "future" } })).toThrow("unknown adapter");
    expect(() => specFromRow({ ...good, computer: { type: "sandbox", profileId: "default", workingDirectory: "/run", network: "public" } })).toThrow();
    expect(() => specFromRow({ ...good, toolset: { ...(spec.toolset as object), nativeTools: [{ harness: "codex", tool: "Read" }] } })).toThrow("unknown built-in tool");
    expect(() => specFromRow({ ...good, execution: null })).toThrow();
  });
});

describe("audit rows", () => {
  const base = { toolName: "context.read", arguments: { dimensions: ["memory"] }, status: "ok" as const, resultSummary: null, errorCode: null, durationMs: 3, resultBytes: 42 };
  const user = (via: "mcp" | "cli" | "app") =>
    personCaller({ userId: parseUserId("33333333-3333-4333-8333-333333333333"), workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"), via });

  it("writes a person's MCP call to the agent query log under the mcp command name", async () => {
    const { client, inserts } = fakeClient();
    await auditToDatabase(client)({ ...base, caller: user("mcp") } as ToolCallRecord);
    expect(inserts).toEqual([
      { table: "agent_query_log", row: { workspace_id: "22222222-2222-4222-8222-222222222222", user_id: "33333333-3333-4333-8333-333333333333", command: "mcp.context.read", surface: "mcp", status: "ok", duration_ms: 3, error_code: null, args_json: { dimensions: ["memory"] }, result_bytes: 42 } },
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
    await auditToDatabase(client)({ ...base, caller: runCaller(spec) } as ToolCallRecord);
    expect(inserts[0]).toMatchObject({ table: "agent_run_tool_calls", row: { agent_run_id: spec.id, tool_name: "context.read", status: "ok", duration_ms: 3 } });
  });
});
