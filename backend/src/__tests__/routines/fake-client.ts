import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };

/** A unique index. Its name appears in the 23505 message, and `where` limits it to a partial index's rows. */
export interface UniqueIndex {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Column sets that must stay unique per table, as in the real indexes. */
  unique: Record<string, Array<string[] | UniqueIndex>>;
  rpcs: Record<string, RpcHandler>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Tables whose new rows get a UUID id instead of `table-n`. */
  uuidTables: string[];
  /** Column values a new row takes when its insert leaves them out, as the table's column defaults would. */
  defaults: Record<string, Row>;
}

export function fakeDb(tables: Record<string, Row[]> = {}, extra: Partial<Pick<FakeDb, "unique" | "rpcs" | "uuidTables" | "defaults">> = {}): FakeDb {
  return { tables, unique: extra.unique ?? {}, rpcs: extra.rpcs ?? {}, rpcCalls: [], uuidTables: extra.uuidTables ?? [], defaults: extra.defaults ?? {} };
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | Row[] = {};
  private conflict: string[] = [];
  private ignoreDuplicates = false;
  private returning = false;
  private cap = Infinity;
  private sort: { column: string; ascending: boolean } | null = null;

  constructor(private db: FakeDb, private table: string) {
    db.tables[table] ??= [];
  }

  select() { this.returning = true; return this; }
  insert(row: Row | Row[]) { this.mode = "insert"; this.payload = row; return this; }
  upsert(row: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.mode = "upsert";
    this.payload = row;
    this.conflict = options.onConflict?.split(",") ?? [];
    this.ignoreDuplicates = options.ignoreDuplicates ?? false;
    return this;
  }
  update(row: Row) { this.mode = "update"; this.payload = row; return this; }
  delete() { this.mode = "delete"; return this; }
  eq(column: string, value: unknown) { this.filters.push((r) => r[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((r) => r[column] !== value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((r) => values.includes(r[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((r) => (r[column] ?? null) === value); return this; }
  not(column: string, operator: string, value: unknown) {
    this.filters.push((r) => (operator === "is" ? (r[column] ?? null) !== value : r[column] !== value));
    return this;
  }
  /** Supports the `col.is.null` and `col.neq.value` terms. A NULL column matches only the `is.null` term, as SQL does. */
  or(expression: string) {
    const terms = expression.split(",").map((term) => {
      const [column = "", operator = "", ...rest] = term.split(".");
      const value = rest.join(".");
      if (operator === "is") return (r: Row) => (r[column] ?? null) === null;
      if (operator === "neq") return (r: Row) => r[column] != null && r[column] !== value;
      throw new Error(`fake-client cannot evaluate the or-term ${term}`);
    });
    this.filters.push((r) => terms.some((term) => term(r)));
    return this;
  }
  gt(column: string, value: string | number) { this.filters.push((r) => r[column] !== null && r[column] !== undefined && (r[column] as string | number) > value); return this; }
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
    if (this.mode === "upsert") {
      const row = { ...(this.payload as Row) };
      const existing = rows.find((r) => this.conflict.length > 0 && this.conflict.every((c) => r[c] === row[c]));
      if (existing) {
        if (this.ignoreDuplicates) return { data: [], error: null };
        Object.assign(existing, row);
        return { data: this.returning ? [existing] : null, error: null };
      }
    }
    if (this.mode === "insert" || this.mode === "upsert") {
      const defaults = this.db.defaults[this.table] ?? {};
      const inserts = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((input) => ({ ...defaults, ...input }));
      for (const [at, row] of inserts.entries()) {
        for (const entry of this.db.unique[this.table] ?? []) {
          const index: UniqueIndex = Array.isArray(entry) ? { name: entry.join(","), columns: entry } : entry;
          const inIndex = (r: Row) => (index.where ? index.where(r) : true) && index.columns.every((c) => r[c] != null);
          if (inIndex(row) && rows.some((r) => inIndex(r) && index.columns.every((c) => r[c] === row[c]))) {
            return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${index.name}"` } };
          }
        }
        if (row.id === undefined) row.id = this.db.uuidTables.includes(this.table) ? crypto.randomUUID() : `${this.table}-${rows.length + at + 1}`;
      }
      rows.push(...inserts);
      return { data: this.returning ? inserts : null, error: null };
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
    if (this.mode === "delete") {
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return { data: this.returning ? matched : null, error: null };
    }
    return { data: matched, error: null, count: matched.length } as { data: unknown; error: unknown };
  }
}

/** A client whose queries on one table all fail with `message`. Every other table goes to the base client. */
export function failingOn(base: SupabaseClient, table: string, message = "db down"): SupabaseClient {
  const failing = () => {
    const query: Record<string, unknown> = {};
    for (const step of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "update", "insert"]) query[step] = () => query;
    query.maybeSingle = async () => ({ data: null, error: new Error(message) });
    query.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: new Error(message) });
    return query;
  };
  return { from: (name: string) => (name === table ? failing() : base.from(name)), rpc: base.rpc } as unknown as SupabaseClient;
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
