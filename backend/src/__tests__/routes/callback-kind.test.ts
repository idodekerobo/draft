import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callbackKind } from "../../routes/callback-kind";

const RUN = "55555555-5555-4555-8555-555555555555";

function clientWith(rows: Array<{ id: string; kind: string }>, failWith?: Error): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "agent_runs") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => ({ data: rows.find((row) => row.id === id) ?? null, error: failWith ?? null }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("callbackKind", () => {
  it("routes by the kind of the agent run named by the id", async () => {
    for (const kind of ["synthesis", "routine", "summarization"] as const) {
      expect(await callbackKind(RUN, clientWith([{ id: RUN, kind }]))).toBe(kind);
    }
  });

  it("still routes an id in the older prefixed form by its prefix, without a lookup", async () => {
    const noLookups = { from: () => { throw new Error("no lookup expected"); } } as unknown as SupabaseClient;
    expect(await callbackKind(`routine:${RUN}`, noLookups)).toBe("routine");
    expect(await callbackKind(`summarize:workspace-1:${RUN}`, noLookups)).toBe("summarization");
  });

  it("gives an unknown id to the synthesis handler, which answers it as it always has", async () => {
    expect(await callbackKind(RUN, clientWith([]))).toBe("synthesis");
    expect(await callbackKind("not-a-run-id", clientWith([]))).toBe("synthesis");
    expect(await callbackKind("", clientWith([]))).toBe("synthesis");
  });

  it("does not guess when the lookup fails", async () => {
    await expect(callbackKind(RUN, clientWith([], new Error("db down")))).rejects.toThrow("db down");
  });

  it("ignores an agent run of a kind that has no callback", async () => {
    expect(await callbackKind(RUN, clientWith([{ id: RUN, kind: "interactive" }]))).toBe("synthesis");
  });
});
