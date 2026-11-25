import { expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditToDatabase } from "../../metaharness/runs/agent-run-store";
import { personCaller } from "draft-core/tools";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";

test("session MCP calls retain agent accounting and server-validated session attribution", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const client = { from: (table: string) => ({ insert: async (row: Record<string, unknown>) => { expect(table).toBe("agent_query_log"); rows.push(row); return { error: null }; } }) } as unknown as SupabaseClient;
  const record = {
    caller: personCaller({ userId: parseUserId("11111111-1111-4111-8111-111111111111"), workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"), via: "mcp" }),
    toolName: "context.read", resultBytes: 12, arguments: {}, status: "ok" as const,
    resultSummary: null, errorCode: null, durationMs: 10,
  };
  await auditToDatabase(client, "33333333-3333-4333-8333-333333333333")(record);
  expect(rows[0]).toMatchObject({ command: "mcp.context.read", surface: "mcp", session_id: "33333333-3333-4333-8333-333333333333", result_bytes: 12 });
  await auditToDatabase(client)(record);
  expect(rows[1]).not.toHaveProperty("session_id");
});
