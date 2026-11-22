import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
}

// Minimal in-memory stand-in for the PostgREST builder, covering only the
// calls the Google code makes.
export function createFakeDb(
  seed: Record<string, Row[]> = {},
  rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {},
): FakeDb {
  const tables: Record<string, Row[]> = new Proxy({} as Record<string, Row[]>, {
    get: (target, name: string) => (target[name] ??= []),
  });
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const rpcs: FakeDb["rpcs"] = [];
  let idCounter = 0;

  function from(table: string) {
    tables[table] ??= [];
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitCount: number | null = null;

    function execute(): { data: Row[]; error: null } {
      const rows = tables[table]!;
      if (mode === "insert") {
        const inserted = (Array.isArray(payload) ? payload : [payload!]).map((row) => ({
          id: `${table}-${++idCounter}`,
          ...row,
        }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (mode === "upsert") {
        const conflictColumns = (upsertOptions.onConflict ?? "id").split(",");
        const out: Row[] = [];
        for (const incoming of Array.isArray(payload) ? payload : [payload!]) {
          const existing = rows.find((row) => conflictColumns.every((column) => row[column] === incoming[column]));
          if (existing) {
            if (!upsertOptions.ignoreDuplicates) Object.assign(existing, incoming);
            out.push(existing);
          } else {
            const created = { id: `${table}-${++idCounter}`, ...incoming };
            rows.push(created);
            out.push(created);
          }
        }
        return { data: out, error: null };
      }
      const matched = rows.filter((row) => filters.every((filter) => filter(row)));
      if (mode === "delete") {
        const matchedRows = rows.filter((row) => filters.every((filter) => filter(row)));
        tables[table] = rows.filter((row) => !matchedRows.includes(row));
        return { data: matchedRows, error: null };
      }
      if (mode === "update") {
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      return { data: limitCount === null ? matched : matched.slice(0, limitCount), error: null };
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (row: Row | Row[]) => {
        mode = "insert";
        payload = row;
        return builder;
      },
      delete: () => {
        mode = "delete";
        return builder;
      },
      update: (row: Row) => {
        mode = "update";
        payload = row;
        return builder;
      },
      upsert: (row: Row | Row[], options: typeof upsertOptions = {}) => {
        mode = "upsert";
        payload = row;
        upsertOptions = options;
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
      neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
      contains: (column: string, values: unknown[]) => (
        filters.push((row) => Array.isArray(row[column]) && values.every((value) => (row[column] as unknown[]).includes(value))),
        builder
      ),
      is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
      not: (column: string, operator: string, value: unknown) => {
        if (operator === "is") filters.push((row) => (row[column] ?? null) !== value);
        return builder;
      },
      lt: (column: string, value: string) => (filters.push((row) => String(row[column]) < value), builder),
      // Supports only the "col.eq.value,col.eq.value" form readSource uses.
      or: (expression: string) => {
        const clauses = expression.split(",").map((clause) => clause.split(".eq."));
        filters.push((row) => clauses.some(([column, value]) => String(row[column!]) === value));
        return builder;
      },
      order: () => builder,
      limit: (count: number) => ((limitCount = count), builder),
      maybeSingle: async () => {
        const { data } = execute();
        return { data: data[0] ?? null, error: null };
      },
      single: async () => {
        const { data } = execute();
        return data[0] ? { data: data[0], error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (resolve: (value: { data: Row[] | null; error: null }) => unknown) => {
        const result = execute();
        return Promise.resolve(resolve(result));
      },
    };
    return builder;
  }

  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      const handler = rpcHandlers[name];
      return { data: handler ? handler(args) : null, error: null };
    },
  } as unknown as SupabaseClient;

  return { client, tables, rpcs };
}
