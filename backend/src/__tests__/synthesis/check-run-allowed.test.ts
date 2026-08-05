import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRunAllowed } from "../../synthesis/check-run-allowed";

interface FakeWorkspace {
  id: string;
  runs_enabled: boolean;
  max_runs_per_day: number | null;
}

function createFakeClient(workspace: FakeWorkspace, runCountToday: number) {
  const client = {
    from: (table: string) => {
      if (table === "workspaces") {
        return {
          select: () => ({
            eq: (_field: string, _value: string) => ({
              single: async () => ({
                data: { runs_enabled: workspace.runs_enabled, max_runs_per_day: workspace.max_runs_per_day },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "synthesis_runs") {
        return {
          select: (_columns: string, _opts: { count: string; head: boolean }) => ({
            eq: () => ({
              gte: async () => ({ count: runCountToday, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return client;
}

describe("checkRunAllowed", () => {
  it("denies when runs_enabled is false", async () => {
    const client = createFakeClient({ id: "w1", runs_enabled: false, max_runs_per_day: null }, 0);
    const result = await checkRunAllowed("w1", client);
    expect(result).toEqual({ ok: false, reason: "runs_enabled is false for this workspace" });
  });

  it("allows when runs_enabled is true and no max_runs_per_day is set", async () => {
    const client = createFakeClient({ id: "w1", runs_enabled: true, max_runs_per_day: null }, 999);
    const result = await checkRunAllowed("w1", client);
    expect(result).toEqual({ ok: true });
  });

  it("denies when today's run count meets max_runs_per_day", async () => {
    const client = createFakeClient({ id: "w1", runs_enabled: true, max_runs_per_day: 3 }, 3);
    const result = await checkRunAllowed("w1", client);
    expect(result.ok).toBe(false);
  });

  it("allows when today's run count is under max_runs_per_day", async () => {
    const client = createFakeClient({ id: "w1", runs_enabled: true, max_runs_per_day: 3 }, 2);
    const result = await checkRunAllowed("w1", client);
    expect(result).toEqual({ ok: true });
  });
});
