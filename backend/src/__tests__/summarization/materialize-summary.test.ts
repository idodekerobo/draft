import { describe, expect, test } from "bun:test";
import { materializeSessionSummary } from "../../summarization/materialize-summary";
import type { CapturedSessionRow } from "../../types/tables";

function baseSession(overrides: Partial<CapturedSessionRow> = {}): CapturedSessionRow {
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
    transcript_revision: 1,
    summary_status: "leased",
    summary_attempts: 1,
    summary_lease_until: "2026-08-01T01:30:00.000Z",
    summary_last_error: null,
    summary_agent_run_id: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

type LogRow = { workspace_id: string; user_id: string; command: string; occurred_at: string };

function fakeClient(options: { logRows?: LogRow[]; logError?: unknown } = {}) {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const logQueries: number[] = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; eq: [string, unknown][] }> = [];
  const client = {
    from: (table: string) => {
      if (table === "connections") {
        return {
          upsert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "connection-1", workspace_id: "workspace-1" }, error: null }),
            }),
          }),
        };
      }
      if (table === "agent_query_log") {
        logQueries.push(1);
        const preds: Array<(row: LogRow) => boolean> = [];
        const builder = {
          select: () => builder,
          eq: (column: keyof LogRow, value: string) => (preds.push((r) => r[column] === value), builder),
          gte: (column: keyof LogRow, value: string) => (preds.push((r) => r[column] >= value), builder),
          lte: (column: keyof LogRow, value: string) => (preds.push((r) => r[column] <= value), builder),
          or: (expr: string) => {
            const prefixes = expr.split(",").map((part) => part.replace("command.like.", "").replace("%", ""));
            preds.push((r) => prefixes.some((prefix) => r.command.startsWith(prefix)));
            return builder;
          },
          limit: async (n: number) =>
            options.logError
              ? { data: null, error: options.logError }
              : { data: (options.logRows ?? []).filter((r) => preds.every((p) => p(r))).slice(0, n), error: null },
        };
        return builder;
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
      if (table === "captured_sessions") {
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "upsert_source_item") {
        rpcCalls.push(args);
        return { data: { item_id: "item-1", changed: true, superseded_item_ids: [] }, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    },
  };
  return { client: client as unknown as import("@supabase/supabase-js").SupabaseClient, updates, rpcCalls, logQueries };
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

  const okResult = {
    ok: true as const,
    payload: { who: "alice", project: "draft", outcome: "shipped", keyDecisions: [] },
  };
  const gmailRow = (occurred_at: string, command = "mcp.gmail.search"): LogRow => ({
    workspace_id: "workspace-1",
    user_id: "user-1",
    command,
    occurred_at,
  });

  test("is private to the owner when a Gmail tool ran inside the session window", async () => {
    const { client, rpcCalls } = fakeClient({ logRows: [gmailRow("2026-08-01T00:30:00.000Z", "gmail.read")] });
    await materializeSessionSummary(baseSession(), okResult, client);
    expect(rpcCalls[0]).toMatchObject({ p_visibility: "private", p_owner_user_id: "user-1" });
  });

  test("stays shared when the Gmail call was outside the session window", async () => {
    const { client, rpcCalls } = fakeClient({ logRows: [gmailRow("2026-08-01T02:00:00.000Z")] });
    await materializeSessionSummary(baseSession(), okResult, client);
    expect(rpcCalls[0]).toMatchObject({ p_visibility: "shared", p_owner_user_id: null });
  });

  test("stays shared without a user and does not query the log", async () => {
    const { client, rpcCalls, logQueries } = fakeClient({ logRows: [gmailRow("2026-08-01T00:30:00.000Z")] });
    await materializeSessionSummary(baseSession({ user_id: null }), okResult, client);
    expect(logQueries).toHaveLength(0);
    expect(rpcCalls[0]).toMatchObject({ p_visibility: "shared" });
  });

  test("is private when the Gmail usage lookup fails", async () => {
    const { client, rpcCalls } = fakeClient({ logError: { message: "db down" } });
    await materializeSessionSummary(baseSession(), okResult, client);
    expect(rpcCalls[0]).toMatchObject({ p_visibility: "private", p_owner_user_id: "user-1" });
  });
});
