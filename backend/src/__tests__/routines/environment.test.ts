import { describe, expect, it, mock } from "bun:test";
import { validateAgentRoutineConfig, parseAgentRoutineConfig } from "../../routines/config";
import { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import type { LaunchRoutineRun } from "../../routines/launch-routine-run";
import { buildRoutineRunSpec } from "../../routines/run-spec";
import type { ScheduledTaskRow } from "../../types/tables";
import { fakeClient, fakeDb } from "./fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "77777777-7777-4777-8777-777777777777";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";
const OWNER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "77777777-7777-4777-8777-777777777777";
const OWN = "00000000-0000-4000-8000-000000000001";
const SHARED = "00000000-0000-4000-8000-000000000002";
const THEIRS = "00000000-0000-4000-8000-000000000003";
const GONE = "00000000-0000-4000-8000-000000000004";

const base = { title: "Digest", prompt: "Summarize.", harness: "claude", model: null };

describe("routine config environment", () => {
  it("is optional, and a config without one stays as it was", () => {
    const result = validateAgentRoutineConfig(base);
    expect(result).toEqual({ ok: true, config: { title: "Digest", prompt: "Summarize.", harness: "claude", model: null } });
    expect(validateAgentRoutineConfig({ ...base, environment: null })).toMatchObject({ ok: true });
  });

  it("accepts built-in tools from the cloud list for its harness, and connections with the tools allowed", () => {
    const result = validateAgentRoutineConfig({
      ...base,
      environment: { nativeTools: ["WebSearch", "Grep", "WebSearch"], mcpServers: [{ connectionId: OWN, tools: ["search_issues"] }, { connectionId: SHARED, tools: "all" }] },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.config.environment).toEqual({
      nativeTools: ["WebSearch", "Grep"],
      mcpServers: [{ connectionId: OWN, tools: ["search_issues"] }, { connectionId: SHARED, tools: "all" }],
    });
    expect(validateAgentRoutineConfig({ ...base, harness: "codex", environment: { nativeTools: ["web_search"] } })).toMatchObject({ ok: true });
  });

  it("refuses a tool that would widen the sandbox, or that belongs to the other harness", () => {
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "shell"]) {
      expect(validateAgentRoutineConfig({ ...base, environment: { nativeTools: [tool] } })).toEqual({ ok: false, field: "environment" });
    }
    expect(validateAgentRoutineConfig({ ...base, harness: "codex", environment: { nativeTools: ["WebSearch"] } })).toEqual({ ok: false, field: "environment" });
  });

  it("refuses a malformed environment", () => {
    const bad = (environment: unknown) => validateAgentRoutineConfig({ ...base, environment });
    expect(bad("tools")).toEqual({ ok: false, field: "environment" });
    expect(bad({ nativeTools: "WebSearch" })).toEqual({ ok: false, field: "environment" });
    expect(bad({ mcpServers: [{ connectionId: "not-a-uuid", tools: "all" }] })).toEqual({ ok: false, field: "environment" });
    expect(bad({ mcpServers: [{ connectionId: OWN, tools: "some" }] })).toEqual({ ok: false, field: "environment" });
    expect(bad({ mcpServers: [{ connectionId: OWN, tools: [""] }] })).toEqual({ ok: false, field: "environment" });
    expect(bad({ mcpServers: Array.from({ length: 11 }, () => ({ connectionId: OWN, tools: "all" })) })).toEqual({ ok: false, field: "environment" });
  });

  it("keeps the environment when a saved config is read back", () => {
    const saved = { ...base, environment: { nativeTools: ["WebSearch"], mcpServers: [] } };
    expect(parseAgentRoutineConfig(saved)?.environment).toEqual({ nativeTools: ["WebSearch"], mcpServers: [] });
  });
});

describe("a routine run's environment", () => {
  const routine = { ...base, harness: "claude" as const, environment: { nativeTools: ["WebSearch"], mcpServers: [] } };

  it("carries the chosen tools and connections into the spec", () => {
    const spec = buildRoutineRunSpec({
      id: "22222222-2222-4222-8222-222222222222", workspaceId: WS, scheduledTaskId: TASK, ownerUserId: "66666666-6666-4666-8666-666666666666", occurrenceAt: "2026-11-09T09:00:00.000Z",
      routine, contextVersionId: VERSION, mcpServers: [{ connectionId: OWN, tools: "all" }],
    });
    if (spec.runtime.type !== "cloud") throw new Error("unreachable");
    expect(spec.runtime.environment.nativeTools.map((tool) => tool.tool)).toEqual(["Read", "Glob", "WebSearch"]);
    expect(spec.runtime.environment.mcpServers.map((server) => [server.connectionId as string, server.tools])).toEqual([[OWN, "all"]]);
  });
});

describe("dispatch resolves a routine's connections", () => {
  const task = {
    id: TASK, workspace_id: WS, task_type: "agent_routine", created_by_user_id: OWNER,
    config_json: {
      ...base,
      environment: { nativeTools: ["WebSearch"], mcpServers: [OWN, SHARED, THEIRS, GONE].map((connectionId) => ({ connectionId, tools: "all" })) },
    },
  } as unknown as ScheduledTaskRow;

  const connection = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, workspace_id: WS, provider: "mcp", status: "active", connection_key: `https://${id.slice(-1)}.example.com/mcp`,
    display_name: id.slice(-1), credential_id: null, config_json: { tools: [] }, connected_by_user_id: OWNER, ...overrides,
  });

  function newDb() {
    return fakeDb(
      {
        sessions: [], errors: [], agent_runs: [],
        workspaces: [{ id: WS, team_id: TEAM, timezone: "UTC", current_context_version_id: VERSION }],
        users: [{ id: OWNER, status: "active", primary_team_id: TEAM }],
        workspace_context_versions: [{ id: VERSION, version_number: 1, documents_json: {} }],
        source_connections: [
          connection(OWN),
          connection(SHARED, { connected_by_user_id: null }),
          connection(THEIRS, { connected_by_user_id: STRANGER }),
          connection(GONE, { status: "revoked" }),
        ],
      },
      { unique: { sessions: [["workspace_id", "idempotency_key"]] } },
    );
  }

  it("gives the run its owner's and the shared connections, drops the rest, and reports them once", async () => {
    const db = newDb();
    const launch = mock<LaunchRoutineRun>(async () => ({ machineId: "m1" }));
    await dispatchAgentRoutine({ task, occurrenceAt: "2026-11-09T09:00:00.000Z", config: {} as never, client: fakeClient(db), launch });

    const run = db.tables.agent_runs![0]!;
    const environment = (run.runtime as { environment: { nativeTools: Array<{ tool: string }>; mcpServers: Array<{ connectionId: string }> } }).environment;
    expect(environment.mcpServers.map((server) => server.connectionId)).toEqual([OWN, SHARED]);
    expect(environment.nativeTools.map((tool) => tool.tool)).toEqual(["Read", "Glob", "WebSearch"]);
    expect(run.status).toBe("running");

    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ scheduled_task_id: TASK, detail_json: { code: "routine_mcp_connection_unavailable" } });
    expect(JSON.stringify(db.tables.errors![0])).toContain(THEIRS);
    expect(JSON.stringify(db.tables.errors![0])).toContain(GONE);
  });

  it("starts a routine with no connections without looking any up or reporting anything", async () => {
    const db = newDb();
    const plain = { ...task, config_json: { ...base } } as unknown as ScheduledTaskRow;
    await dispatchAgentRoutine({ task: plain, occurrenceAt: "2026-11-09T09:00:00.000Z", config: {} as never, client: fakeClient(db), launch: mock<LaunchRoutineRun>(async () => undefined) });
    expect(db.tables.errors).toHaveLength(0);
    expect((db.tables.agent_runs![0]!.runtime as { environment: { mcpServers: unknown[] } }).environment.mcpServers).toEqual([]);
  });
});
