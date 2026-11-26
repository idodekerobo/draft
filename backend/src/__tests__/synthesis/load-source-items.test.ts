import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSourceItemsByIds } from "../../synthesis/load-source-items";

function client(rows: Array<{ id: string; workspace_id: string }>) {
  const requests: number[] = [];
  const fake = {
    from: () => ({
      select: () => ({
        eq: (_column: string, workspaceId: string) => ({
          in: async (_idColumn: string, wanted: string[]) => {
            requests.push(wanted.length);
            return { data: rows.filter((row) => row.workspace_id === workspaceId && wanted.includes(row.id)), error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return { fake, requests };
}

describe("loadSourceItemsByIds", () => {
  it("asks for no more than 100 ids at a time, and returns every item it finds", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `id-${index}`, workspace_id: "w1" }));
    const { fake, requests } = client(rows);
    const found = await loadSourceItemsByIds<{ id: string }>(fake, "w1", rows.map((row) => row.id), "id");
    expect(requests).toEqual([100, 100, 50]);
    expect(found.size).toBe(250);
  });

  it("makes no request for no ids, leaves out an id with no item, and stays inside the workspace", async () => {
    const { fake, requests } = client([{ id: "a", workspace_id: "w1" }, { id: "b", workspace_id: "w2" }]);
    expect((await loadSourceItemsByIds(fake, "w1", [], "id")).size).toBe(0);
    expect(requests).toEqual([]);
    const found = await loadSourceItemsByIds<{ id: string }>(fake, "w1", ["a", "b", "missing"], "id");
    expect([...found.keys()]).toEqual(["a"]);
  });
});
