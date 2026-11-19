import { describe, expect, it } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller, type UserCallSurface } from "draft-core/tools";
import { auditToDatabase } from "../../../metaharness/runs/agent-run-store";
import type { ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import { DRAFT_TOOLS } from "draft-core/tools";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function record(toolName: string, via: UserCallSurface): ToolCallRecord {
  return {
    caller: personCaller({ userId: parseUserId(USER), workspaceId: parseWorkspaceId(WS), via }),
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
  it("logs every registered tool for CLI and MCP, including routine writes", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const client = { from: () => ({ insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }) }) };
    const audit = auditToDatabase(client as never);
    for (const tool of DRAFT_TOOLS) {
      await audit(record(tool.name, "cli"));
      await audit(record(tool.name, "mcp"));
    }
    expect(inserted).toHaveLength(DRAFT_TOOLS.length * 2);
    for (const tool of ["routines.create", "sources.list", "sessions.list", "sessions.read"]) {
      expect(inserted.some((row) => row.command === tool)).toBe(true);
      expect(inserted.some((row) => row.command === `mcp.${tool}`)).toBe(true);
    }
    expect(inserted.every((row) => row.status === "ok" && row.duration_ms === 1)).toBe(true);
  });

  it("logs a CLI read under its tool name and an MCP read under mcp.<name>, and skips only the app", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const client = { from: () => ({ insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }) }) };
    const audit = auditToDatabase(client as never);
    await audit(record("sources.search", "cli"));
    await audit(record("skills.list", "mcp"));
    await audit(record("sources.search", "app"));
    await audit(record("sources.search", "web_app"));
    await audit(record("sources.search", "desktop_app"));
    await audit(record("skills.update", "cli"));
    expect(inserted.map((row) => row.command)).toEqual(["sources.search", "mcp.skills.list", "skills.update"]);
  });
});
