import { beforeEach, describe, expect, it, mock } from "bun:test";

let insertError: { code: string; message: string } | null = null;
const insertedRows: Array<Record<string, unknown>> = [];
const logged: Array<{ command: string; argsJson: Record<string, unknown> }> = [];

function maybeSingleFor(table: string) {
  if (table === "users") return { primary_team_id: "team-1" };
  if (table === "workspaces") return { id: "ws-1" };
  throw new Error(`unexpected table: ${table}`);
}

function queryBuilder(table: string) {
  let insertPayload: Record<string, unknown> | undefined;
  const builder = {
    select: () => builder,
    eq: () => builder,
    insert: (payload: Record<string, unknown>) => { insertPayload = payload; return builder; },
    async maybeSingle() { return { data: maybeSingleFor(table), error: null }; },
    async single() {
      if (table !== "skills") throw new Error(`unexpected table: ${table}`);
      if (insertError) return { data: null, error: insertError };
      const row = {
        ...insertPayload,
        license: null, compatibility: null, metadata: null, allowed_tools: null,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", updated_by: null,
      };
      insertedRows.push(row);
      return { data: row, error: null };
    },
  };
  return builder;
}

mock.module("../../db/client", () => ({ serviceClient: { from: (table: string) => queryBuilder(table) } }));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => null }));
mock.module("../../observability/record-query-log", () => ({
  recordAgentQueryLog: async (_client: unknown, input: { command: string; argsJson: Record<string, unknown> }) => {
    logged.push(input);
  },
}));

const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { buildMcpServer } = await import("../../mcp/tools");

async function callSkillsAdd(scopes: string[], args: Record<string, unknown>) {
  const handler = createMcpHandler(() => buildMcpServer("user-1", scopes));
  const response = await handler.fetch(
    new Request("http://internal.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "skills.add", arguments: args },
      }),
    }),
  );
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }> };
}

const validArgs = { name: "weekly-recap", description: "Summarize the week.", content: "Step 1. Do the thing." };

describe("mcp skills.add", () => {
  beforeEach(() => {
    insertError = null;
    insertedRows.length = 0;
    logged.length = 0;
  });

  it("rejects a read-only token without writing", async () => {
    const result = await callSkillsAdd(["read"], validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("insufficient_scope");
    expect(insertedRows).toHaveLength(0);
  });

  it("creates the skill for a write token and records the caller as author", async () => {
    const result = await callSkillsAdd(["read", "write"], validArgs);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).name).toBe("weekly-recap");
    expect(insertedRows[0]).toMatchObject({ workspace_id: "ws-1", created_by: "user-1" });
  });

  it("logs the name and size, not the skill content", async () => {
    await callSkillsAdd(["write"], validArgs);
    expect(logged[0]!.command).toBe("mcp.skills.add");
    expect(logged[0]!.argsJson).toEqual({ name: "weekly-recap", contentBytes: validArgs.content.length });
  });

  it("returns duplicate_name when the name exists", async () => {
    insertError = { code: "23505", message: "duplicate key" };
    const result = await callSkillsAdd(["write"], validArgs);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "duplicate_name" });
  });
});
