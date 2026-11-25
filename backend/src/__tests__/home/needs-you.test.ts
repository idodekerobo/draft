import { expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNeedsYou } from "../../home/needs-you";

// The service client bypasses row security, so getNeedsYou is the only thing that keeps another person's Home
// session out of the list. Every table answers with canned rows; the query chain is not modelled.
function fakeClient(tables: Record<string, unknown[]>): SupabaseClient {
  const builder = (table: string): unknown => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_target, key) {
        if (key === "then") return (resolve: (value: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
        if (key === "maybeSingle" || key === "single") return async () => ({ data: null, error: null });
        return () => self;
      },
    });
    return self;
  };
  return { from: builder } as unknown as SupabaseClient;
}

const session = (id: string, owner: string, isHome: boolean) => ({
  id, title: id, open_approval_count: 1, last_event_at: null, started_at: "2026-11-25T10:00:00Z", owner_user_id: owner, is_home: isHome,
});

test("another person's Home approval never appears; mine and team sessions do", async () => {
  const client = fakeClient({ sessions: [session("their-home", "u-other", true), session("my-home", "u-me", true), session("team", "u-other", false)] });
  const result = await getNeedsYou(client, "ws-1", "u-me");
  const approvals = result.rows.filter((row) => row.kind === "approval").map((row) => row.id).sort();
  expect(approvals).toEqual(["my-home", "team"]);
});
