import { beforeEach, describe, expect, it, mock } from "bun:test";

let primaryTeamId: string | null = "team-1";
let accessResult: Response | null = null;
const logged: Array<{ command: string; argsJson: Record<string, unknown> }> = [];
const tasks = [
  {
    id: "task-1", workspace_id: "ws-1", source_connection_id: null, task_type: "summarize_sessions",
    schedule_kind: "cron", cron_expression: "0 3 * * *", interval_seconds: null, timezone: "UTC",
    enabled: true, next_due_at: "2026-10-06T03:00:00.000Z", last_enqueued_at: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_by_user_id: null,
  },
];

function queryBuilder(table: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      if (table === "users") return { data: { primary_team_id: primaryTeamId }, error: null };
      return { data: { id: "ws-1" }, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      return resolve({ data: table === "scheduled_tasks" ? tasks : [], error: null });
    },
  };
  return builder;
}

mock.module("../../db/client", () => ({ serviceClient: { from: (table: string) => queryBuilder(table) } }));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../observability/record-query-log", () => ({
  recordAgentQueryLog: async (_client: unknown, input: { command: string; argsJson: Record<string, unknown> }) => {
    logged.push(input);
  },
}));

const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { buildMcpServer } = await import("../../mcp/tools");

async function callRoutinesList() {
  const handler = createMcpHandler(() => buildMcpServer("user-1", ["read"]));
  const response = await handler.fetch(
    new Request("http://internal.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "routines.list", arguments: {} },
      }),
    }),
  );
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }> };
}

describe("mcp routines.list", () => {
  beforeEach(() => {
    primaryTeamId = "team-1";
    accessResult = null;
    logged.length = 0;
  });

  it("returns the routines with their cron expression and logs the call", async () => {
    const result = await callRoutinesList();
    expect(result.isError).toBeUndefined();
    const { routines } = JSON.parse(result.content[0]!.text) as { routines: Array<Record<string, unknown>> };
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ id: "task-1", cron: "0 3 * * *", intervalSeconds: null });
    expect(logged[0]!.command).toBe("mcp.routines.list");
  });

  it("returns no_workspace when the caller has no workspace", async () => {
    primaryTeamId = null;
    const result = await callRoutinesList();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("no_workspace");
  });

  it("returns forbidden when workspace access is denied", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const result = await callRoutinesList();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("forbidden");
  });
});
