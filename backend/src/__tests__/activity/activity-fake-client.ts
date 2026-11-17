import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeClient, fakeDb } from "../routines/fake-client";

export type Row = Record<string, unknown>;

/** A read that ends in `message` however it is filtered. */
function failedRead(message: string) {
  const read: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message } }) };
  for (const step of ["eq", "in", "order", "returns"]) read[step] = () => read;
  return read;
}

/**
 * The shared fake, plus the `returns` typing call that listActivity chains on its reads.
 * A read whose table and select list match `failRead` answers with an error instead.
 */
export function activityClient(tables: Record<string, Row[]>, failRead: (table: string, columns: string) => boolean = () => false): SupabaseClient {
  const base = fakeClient(fakeDb(tables));
  return {
    from(table: string) {
      const query = base.from(table) as unknown as { select: (columns: string) => unknown; returns: () => unknown };
      const select = query.select.bind(query);
      query.select = (columns: string) => (failRead(table, columns) ? failedRead("read failed") : select(columns));
      query.returns = () => query;
      return query;
    },
  } as unknown as SupabaseClient;
}
