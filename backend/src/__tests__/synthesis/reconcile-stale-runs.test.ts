import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepStaleSynthesisRuns } from "../../synthesis/reconcile-stale-runs";

interface FakeRun {
  id: string;
  workspace_id: string;
  status: string;
  created_at: string;
}

type Filter =
  | { field: string; op: "in"; value: string[] }
  | { field: string; op: "eq"; value: string }
  | { field: string; op: "lt"; value: string };

function matches(row: FakeRun, filters: Filter[]): boolean {
  return filters.every((f) => {
    const rowValue = (row as unknown as Record<string, string>)[f.field];
    if (f.op === "in") return f.value.includes(rowValue);
    if (f.op === "eq") return rowValue === f.value;
    return rowValue < f.value;
  });
}

/**
 * Fake Supabase client backed by an in-memory row array, so `.in()`/`.lt()`/
 * `.eq()` actually filter data instead of just recording calls.
 */
function createFakeClient(initialRuns: FakeRun[]) {
  const rows = initialRuns.map((run) => ({ ...run }));
  const errorInserts: Record<string, unknown>[] = [];

  function chainable<T>(filters: Filter[], resolve: (filters: Filter[]) => T) {
    const builder = {
      in: (field: string, value: string[]) => {
        filters.push({ field, op: "in", value });
        return builder;
      },
      eq: (field: string, value: string) => {
        filters.push({ field, op: "eq", value });
        return builder;
      },
      lt: (field: string, value: string) => {
        filters.push({ field, op: "lt", value });
        return builder;
      },
      then: (onResolve: (value: T) => void) => onResolve(resolve(filters)),
    };
    return builder;
  }

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () =>
          // Cloned so the later update() doesn't mutate this snapshot.
          chainable<{ data: FakeRun[]; error: null }>([], (filters) => ({
            data: rows.filter((row) => matches(row, filters)).map((row) => ({ ...row })),
            error: null,
          })),
        update: (payload: Partial<FakeRun>) =>
          chainable<{ data: null; error: null }>([], (filters) => {
            for (const row of rows) {
              if (matches(row, filters)) Object.assign(row, payload);
            }
            return { data: null, error: null };
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

  const client = { from } as unknown as SupabaseClient;
  return { client, rows, errorInserts };
}

const now = Date.now();
const isoMinutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("sweepStaleSynthesisRuns", () => {
  it("fails an old active-writer row and records one errors row for it", async () => {
    const { client, rows, errorInserts } = createFakeClient([
      {
        id: "run-1",
        workspace_id: "workspace-a",
        status: "running",
        created_at: isoMinutesAgo(45),
      },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ id: "run-1", status: "running" });
    expect(rows[0].status).toBe("failed");
    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({
      workspace_id: "workspace-a",
      synthesis_run_id: "run-1",
      operation: "execution",
    });
  });

  it("leaves a recent active-writer row untouched", async () => {
    const { client, rows, errorInserts } = createFakeClient([
      {
        id: "run-2",
        workspace_id: "workspace-a",
        status: "preparing",
        created_at: isoMinutesAgo(5),
      },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(0);
    expect(rows[0].status).toBe("preparing");
    expect(errorInserts).toHaveLength(0);
  });

  it("never touches rows in a terminal status regardless of age", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-3", workspace_id: "workspace-a", status: "succeeded", created_at: isoMinutesAgo(9999) },
      { id: "run-4", workspace_id: "workspace-a", status: "failed", created_at: isoMinutesAgo(9999) },
      { id: "run-5", workspace_id: "workspace-a", status: "stale", created_at: isoMinutesAgo(9999) },
      { id: "run-6", workspace_id: "workspace-a", status: "cancelled", created_at: isoMinutesAgo(9999) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(0);
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "failed", "stale", "cancelled"]);
  });

  it("sweeps validating and committing rows too, not just running", async () => {
    const { client } = createFakeClient([
      { id: "run-7", workspace_id: "workspace-a", status: "validating", created_at: isoMinutesAgo(45) },
      { id: "run-8", workspace_id: "workspace-a", status: "committing", created_at: isoMinutesAgo(45) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept.map((r) => r.id).sort()).toEqual(["run-7", "run-8"]);
  });

  it("scopes to the given workspace when workspaceId is passed", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-9", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(45) },
      { id: "run-10", workspace_id: "workspace-b", status: "running", created_at: isoMinutesAgo(45) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client, { workspaceId: "workspace-a" });

    expect(swept.map((r) => r.id)).toEqual(["run-9"]);
    expect(rows.find((r) => r.id === "run-9")?.status).toBe("failed");
    expect(rows.find((r) => r.id === "run-10")?.status).toBe("running");
  });

  it("respects a custom olderThanMs threshold", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-11", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(3) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client, { olderThanMs: 60_000 });

    expect(swept).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });
});
