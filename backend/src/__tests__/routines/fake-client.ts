import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Column sets that must stay unique per table, as in the real indexes. */
  unique: Record<string, string[][]>;
  rpcs: Record<string, RpcHandler>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export function fakeDb(tables: Record<string, Row[]> = {}, extra: Partial<Pick<FakeDb, "unique" | "rpcs">> = {}): FakeDb {
  return { tables, unique: extra.unique ?? {}, rpcs: extra.rpcs ?? {}, rpcCalls: [] };
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row = {};
  private returning = false;
  private cap = Infinity;
  private sort: { column: string; ascending: boolean } | null = null;

  constructor(private db: FakeDb, private table: string) {
    db.tables[table] ??= [];
  }

  select() { this.returning = true; return this; }
  insert(row: Row) { this.mode = "insert"; this.payload = row; return this; }
  update(row: Row) { this.mode = "update"; this.payload = row; return this; }
  eq(column: string, value: unknown) { this.filters.push((r) => r[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((r) => r[column] !== value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((r) => values.includes(r[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((r) => (r[column] ?? null) === value); return this; }
  lt(column: string, value: string) { this.filters.push((r) => typeof r[column] === "string" && (r[column] as string) < value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sort = { column, ascending: options?.ascending ?? true }; return this; }
  limit(count: number) { this.cap = count; return this; }
  maybeSingle() { return this.run().then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error })); }
  single() { return this.maybeSingle(); }
  then<T1, T2>(onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    const rows = this.db.tables[this.table]!;
    if (this.mode === "insert") {
      const row = { ...this.payload };
      for (const columns of this.db.unique[this.table] ?? []) {
        if (columns.every((c) => row[c] != null) && rows.some((r) => columns.every((c) => r[c] === row[c]))) {
          return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${columns.join(",")}` } };
        }
      }
      if (row.id === undefined) row.id = `${this.table}-${rows.length + 1}`;
      rows.push(row);
      return { data: this.returning ? [row] : null, error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sort) {
      const { column, ascending } = this.sort;
      matched = [...matched].sort((a, b) => ((a[column] as string) < (b[column] as string) ? -1 : 1) * (ascending ? 1 : -1));
    }
    matched = matched.slice(0, this.cap);
    if (this.mode === "update") {
      for (const row of matched) Object.assign(row, this.payload);
      return { data: this.returning ? matched : null, error: null };
    }
    return { data: matched, error: null };
  }
}

export function fakeClient(db: FakeDb): SupabaseClient {
  return {
    from: (table: string) => new Query(db, table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      const handler = db.rpcs[name];
      if (!handler) return { data: null, error: null };
      const { data = null, error = null } = handler(args);
      return { data, error };
    },
  } as unknown as SupabaseClient;
}
