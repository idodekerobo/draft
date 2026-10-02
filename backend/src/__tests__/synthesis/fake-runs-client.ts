import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeRow = Record<string, unknown>;

export interface FakeRunRow extends FakeRow {
  id: string;
  workspace_id: string;
  status: string;
  created_at: string;
  attempt: number;
  completed_at: string | null;
  scheduled_task_id: string | null;
  retry_of_run_id: string | null;
  sandbox_machine_id: string | null;
}

export function fakeRun(overrides: Partial<FakeRunRow> & { id: string }): FakeRunRow {
  return {
    workspace_id: "workspace-a",
    status: "failed",
    created_at: new Date().toISOString(),
    attempt: 1,
    completed_at: null,
    scheduled_task_id: null,
    retry_of_run_id: null,
    sandbox_machine_id: null,
    ...overrides,
  };
}

function query(rows: FakeRow[], op: "select" | "update", payload?: FakeRow) {
  const filters: Array<(row: FakeRow) => boolean> = [];
  let orderBy: { field: string; ascending: boolean } | null = null;
  let max: number | null = null;

  const run = () => {
    let matched = rows.filter((row) => filters.every((filter) => filter(row)));
    if (op === "update") for (const row of matched) Object.assign(row, payload);
    matched = matched.map((row) => ({ ...row }));
    if (orderBy) {
      const { field, ascending } = orderBy;
      matched.sort((a, b) => ((a[field] as string) < (b[field] as string) ? -1 : 1) * (ascending ? 1 : -1));
    }
    return { data: max === null ? matched : matched.slice(0, max), error: null };
  };

  const builder = {
    eq: (field: string, value: unknown) => (filters.push((r) => r[field] === value), builder),
    in: (field: string, values: unknown[]) => (filters.push((r) => values.includes(r[field])), builder),
    lt: (field: string, value: string) => (filters.push((r) => (r[field] as string) < value), builder),
    lte: (field: string, value: number) => (filters.push((r) => (r[field] as number) <= value), builder),
    gte: (field: string, value: string) =>
      (filters.push((r) => r[field] != null && (r[field] as string) >= value), builder),
    order: (field: string, options: { ascending: boolean }) => ((orderBy = { field, ...options }), builder),
    limit: (n: number) => ((max = n), builder),
    select: () => builder,
    single: async () => ({ data: run().data[0] ?? null, error: null }),
    then: (resolve: (value: ReturnType<typeof run>) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve().then(run).then(resolve, reject),
  };
  return builder;
}

/**
 * In-memory Supabase stand-in: each table is a row array, and the filter
 * methods really filter, so tests assert on resulting state, not call shapes.
 */
export function createFakeRunsClient(tables: {
  synthesis_runs?: FakeRow[];
  workspaces?: FakeRow[];
}) {
  const runs = tables.synthesis_runs ?? [];
  const workspaces = tables.workspaces ?? [];
  const errorInserts: FakeRow[] = [];

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => query(runs, "select"),
        update: (payload: FakeRow) => query(runs, "update", payload),
      };
    }
    if (table === "workspaces") return { select: () => query(workspaces, "select") };
    if (table === "errors") {
      return {
        insert: async (payload: FakeRow) => {
          errorInserts.push(payload);
          return { data: null, error: null };
        },
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { client: { from } as unknown as SupabaseClient, runs, errorInserts };
}
