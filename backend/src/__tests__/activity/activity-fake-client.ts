import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeClient, fakeDb } from "../routines/fake-client";

export type Row = Record<string, unknown>;

/** A read that ends in `message` however it is filtered. */
function failedRead(message: string) {
  const read: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message } }) };
  for (const step of ["eq", "in", "is", "or", "order", "limit", "returns"]) read[step] = () => read;
  return read;
}

/** Splits a PostgREST filter list at the commas outside parentheses. */
function splitClauses(expression: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      clauses.push(expression.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(expression.slice(start));
  return clauses;
}

/** Whether a row meets one `column.eq.value`, `column.lt.value` or `and(...)` clause. Other filters throw. */
function clauseMatches(clause: string, row: Row): boolean {
  const group = /^and\((.*)\)$/.exec(clause);
  if (group) return splitClauses(group[1]!).every((inner) => clauseMatches(inner, row));
  const isNull = /^(\w+)\.is\.null$/.exec(clause);
  if (isNull) return row[isNull[1]!] == null;
  const notIn = /^(\w+)\.not\.in\.\((.*)\)$/.exec(clause);
  if (notIn) return !notIn[2]!.split(",").includes(String(row[notIn[1]!]));
  const match = /^(\w+)\.(eq|lt)\.(.*)$/.exec(clause);
  if (!match) throw new Error(`Unsupported filter in the activity fake: ${clause}`);
  const value = match[3]!.replace(/^"(.*)"$/, "$1");
  const actual = row[match[1]!];
  return match[2] === "eq" ? String(actual) === value : typeof actual === "string" && actual < value;
}

const orMatches = (expression: string, row: Row) => splitClauses(expression).some((clause) => clauseMatches(clause, row));

/**
 * The shared fake, plus the `returns` typing call that listActivity chains on its reads, and `or` for the
 * visibility and cursor filters. A read whose table and select list match `failRead` answers with an error instead.
 */
export function activityClient(tables: Record<string, Row[]>, failRead: (table: string, columns: string) => boolean = () => false): SupabaseClient {
  const base = fakeClient(fakeDb(tables));
  return {
    from(table: string) {
      const query = base.from(table) as unknown as {
        select: (columns: string) => unknown;
        returns: () => unknown;
        or: (expression: string) => unknown;
        in: (column: string, values: unknown[]) => unknown;
        gte: (column: string, value: string) => unknown;
        lt: (column: string, value: string) => unknown;
      };
      const select = query.select.bind(query);
      query.select = (columns: string) => (failRead(table, columns) ? failedRead("read failed") : select(columns));
      query.returns = () => query;
      // Matches the rows now and filters on their ids, so a later limit still applies after the `or`.
      query.or = (expression: string) => query.in("id", (tables[table] ?? []).filter((row) => orMatches(expression, row)).map((row) => row.id));
      query.gte = (column: string, value: string) => query.in("id", (tables[table] ?? []).filter((row) => String(row[column]) >= value).map((row) => row.id));
      query.lt = (column: string, value: string) => query.in("id", (tables[table] ?? []).filter((row) => String(row[column]) < value).map((row) => row.id));
      return query;
    },
  } as unknown as SupabaseClient;
}
