import { describe, expect, it } from "bun:test";
import { auditToDatabase } from "../../../metaharness/runs/agent-run-store";
import type { ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import { isLoggedCommand } from "../../../observability/logged-commands";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function record(toolName: string, via: "mcp" | "cli" | "app"): ToolCallRecord {
  return {
    caller: { type: "user" as const, userId: USER, workspaceId: WS, via },
    toolName,
    resultBytes: 10,
    arguments: {},
    status: "ok" as const,
    resultSummary: null,
    errorCode: null,
    durationMs: 1,
  } as unknown as ToolCallRecord;
}

describe("which calls by a person reach the agent query log", () => {
  it("knows the names the log table accepts, and not a skill write", () => {
    expect(isLoggedCommand("sources.search")).toBe(true);
    expect(isLoggedCommand("mcp.skills.add")).toBe(true);
    expect(isLoggedCommand("skills.update")).toBe(false);
    expect(isLoggedCommand("skills.delete")).toBe(false);
    expect(isLoggedCommand("skills.add")).toBe(false);
  });

  it("logs a CLI read under its tool name and an MCP read under mcp.<name>, and skips the app and unlogged names", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const client = { from: () => ({ insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }) }) };
    const audit = auditToDatabase(client as never);
    await audit(record("sources.search", "cli"));
    await audit(record("skills.list", "mcp"));
    await audit(record("sources.search", "app"));
    await audit(record("skills.update", "cli"));
    expect(inserted.map((row) => row.command)).toEqual(["sources.search", "mcp.skills.list"]);
  });
});
