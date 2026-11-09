import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportExpiredSummaryLeases } from "../../summarization/report-expired-leases";

interface FakeSession {
  id: string;
  workspace_id: string;
  summary_status: string;
  summary_attempts: number;
  summary_lease_until: string | null;
  summary_agent_run_id?: string | null;
}

type Filter =
  | { field: string; op: "eq"; value: string }
  | { field: string; op: "lt"; value: string };

function matches(row: FakeSession, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const rowValue = (row as unknown as Record<string, string | null>)[filter.field];
    if (filter.op === "eq") return rowValue === filter.value;
    return rowValue !== null && rowValue < filter.value;
  });
}

function createFakeClient(rows: FakeSession[], selectError?: Error) {
  const errorInserts: Record<string, unknown>[] = [];
  const runUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];

  function from(table: string) {
    if (table === "agent_sessions") {
      return {
        select: () => {
          const filters: Filter[] = [];
          const builder = {
            eq: (field: string, value: string) => {
              filters.push({ field, op: "eq", value });
              return builder;
            },
            lt: (field: string, value: string) => {
              filters.push({ field, op: "lt", value });
              return builder;
            },
            then: (onResolve: (value: unknown) => void) =>
              onResolve(
                selectError
                  ? { data: null, error: selectError }
                  : { data: rows.filter((row) => matches(row, filters)), error: null },
              ),
          };
          return builder;
        },
      };
    }
    if (table === "agent_runs") {
      return {
        update: (values: Record<string, unknown>) => ({
          eq: (_column: string, id: string) => ({
            in: async () => {
              runUpdates.push({ id, values });
              return { error: null };
            },
          }),
        }),
      };
    }
    if (table === "errors") {
      return {
        insert: async (payload: Record<string, unknown>) => {
          errorInserts.push(payload);
          return { data: null, error: null };
        },
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { client: { from } as unknown as SupabaseClient, errorInserts, runUpdates };
}

const WORKSPACE = "workspace-1";
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const session = (overrides: Partial<FakeSession>): FakeSession => ({
  id: "s1",
  workspace_id: WORKSPACE,
  summary_status: "leased",
  summary_attempts: 1,
  summary_lease_until: hoursFromNow(-1),
  ...overrides,
});

describe("reportExpiredSummaryLeases", () => {
  it("records one error for expired leases, with attempt counts", async () => {
    const { client, errorInserts } = createFakeClient([
      session({ id: "a", summary_attempts: 2 }),
      session({ id: "b", summary_attempts: 3 }),
    ]);

    const count = await reportExpiredSummaryLeases(WORKSPACE, client);

    expect(count).toBe(2);
    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({
      workspace_id: WORKSPACE,
      operation: "execution",
      message: "Summarization run did not report back before its lease expired",
    });
    expect(errorInserts[0].detail_json).toMatchObject({
      code: "summarization_lease_expired",
      session_count: 2,
      session_ids: ["a", "b"],
      max_attempts: 3,
      at_cap_count: 1,
    });
  });

  it("ends the run behind each expired lease once, as failed", async () => {
    const { client, runUpdates } = createFakeClient([
      session({ id: "a", summary_agent_run_id: "run-1" }),
      session({ id: "b", summary_agent_run_id: "run-1" }),
      session({ id: "c", summary_agent_run_id: "run-2" }),
      session({ id: "d", summary_agent_run_id: null }),
    ]);

    await reportExpiredSummaryLeases(WORKSPACE, client);

    expect(runUpdates.map((update) => update.id)).toEqual(["run-1", "run-2"]);
    expect(runUpdates[0]!.values).toMatchObject({ status: "failed", failure_code: "summarization_lease_expired" });
    expect(runUpdates[0]!.values.completed_at).toBeTruthy();
  });

  it("ignores live leases, other statuses, and other workspaces", async () => {
    const { client, errorInserts } = createFakeClient([
      session({ id: "live", summary_lease_until: hoursFromNow(1) }),
      session({ id: "pending", summary_status: "pending", summary_lease_until: null }),
      session({ id: "done", summary_status: "ok" }),
      session({ id: "other", workspace_id: "workspace-2" }),
    ]);

    expect(await reportExpiredSummaryLeases(WORKSPACE, client)).toBe(0);
    expect(errorInserts).toHaveLength(0);
  });

  it("never throws when the read fails", async () => {
    const { client, errorInserts } = createFakeClient([], new Error("db down"));
    const originalError = console.error;
    console.error = () => undefined;
    try {
      expect(await reportExpiredSummaryLeases(WORKSPACE, client)).toBe(0);
    } finally {
      console.error = originalError;
    }
    expect(errorInserts).toHaveLength(0);
  });
});
