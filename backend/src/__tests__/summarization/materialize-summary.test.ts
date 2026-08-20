import { describe, expect, test } from "bun:test";
import { materializeSessionSummary } from "../../summarization/materialize-summary";
import type { AgentSessionRow } from "../../types/tables";

function baseSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "session-1",
    workspace_id: "workspace-1",
    provider: "claude-code",
    user_id: "user-1",
    contributor_id: null,
    external_session_id: "ext-1",
    project: "draft",
    cwd: "/repo",
    started_at: "2026-08-01T00:00:00.000Z",
    ended_at: "2026-08-01T01:00:00.000Z",
    status: "completed",
    summary_status: "leased",
    summary_attempts: 1,
    summary_lease_until: "2026-08-01T01:30:00.000Z",
    summary_last_error: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient() {
  const updates: Array<{ table: string; values: Record<string, unknown>; eq: [string, unknown][] }> = [];
  const client = {
    from: (table: string) => {
      if (table === "source_connections") {
        return {
          upsert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "connection-1", workspace_id: "workspace-1" }, error: null }),
            }),
          }),
        };
      }
      if (table === "source_items") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: "item-1" }, error: null }),
            }),
          }),
        };
      }
      if (table === "agent_sessions") {
        const eqs: [string, unknown][] = [];
        const builder = {
          update: (values: Record<string, unknown>) => {
            updates.push({ table, values, eq: eqs });
            return builder;
          },
          eq: (column: string, value: unknown) => {
            eqs.push([column, value]);
            return column === "summary_status" ? Promise.resolve({ error: null }) : builder;
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: async (name: string) => {
      if (name === "upsert_source_item") {
        return { data: { item_id: "item-1", changed: true, superseded_item_ids: [] }, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    },
  };
  return { client: client as unknown as import("@supabase/supabase-js").SupabaseClient, updates };
}

describe("materializeSessionSummary", () => {
  test("upserts a source item and marks the session ok on success", async () => {
    const { client, updates } = fakeClient();
    const session = baseSession();

    await materializeSessionSummary(
      session,
      { ok: true, payload: { who: "alice", project: "draft", outcome: "shipped", keyDecisions: ["used X"] } },
      client,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({ summary_status: "ok" });
    expect(updates[0].eq).toContainEqual(["id", "session-1"]);
    expect(updates[0].eq).toContainEqual(["summary_status", "leased"]);
  });

  test("marks the session failed on error when attempts remain", async () => {
    const { client, updates } = fakeClient();
    const session = baseSession({ summary_attempts: 1 });

    await materializeSessionSummary(session, { ok: false, error: new Error("boom") }, client);

    expect(updates[0].values).toMatchObject({ summary_status: "failed", summary_last_error: "boom" });
  });

  test("marks the session skipped once attempts are exhausted", async () => {
    const { client, updates } = fakeClient();
    const session = baseSession({ summary_attempts: 3 });

    await materializeSessionSummary(session, { ok: false, error: new Error("boom") }, client);

    expect(updates[0].values).toMatchObject({ summary_status: "skipped" });
  });
});
