import { describe, expect, it } from "bun:test";
import { sweepStaleSynthesisRuns } from "../../synthesis/reconcile-stale-runs";
import { createFakeRunsClient, fakeRun } from "./fake-runs-client";

function createFakeClient(initialRuns: Array<{ id: string; workspace_id: string; status: string; created_at: string }>) {
  const { client, runs, errorInserts } = createFakeRunsClient({
    synthesis_runs: initialRuns.map((run) => fakeRun(run)),
  });
  return { client, rows: runs, errorInserts };
}

const now = Date.now();
const isoMinutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("sweepStaleSynthesisRuns", () => {
  it("fails an old active-writer row and records one errors row for it", async () => {
    const { client, rows, errorInserts } = createFakeClient([
      {
        id: "run-1",
        workspace_id: "workspace-a",
        status: "running",
        created_at: isoMinutesAgo(45),
      },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ id: "run-1", status: "running" });
    expect(rows[0].status).toBe("failed");
    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({
      workspace_id: "workspace-a",
      synthesis_run_id: "run-1",
      operation: "execution",
    });
  });

  it("records the attempt tracking fields and an honest message on the error row", async () => {
    const { client, rows, errorInserts } = createFakeClient([
      { id: "run-t", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(45) },
    ]);
    rows[0].attempt = 2;
    rows[0].sandbox_machine_id = "machine-9";

    await sweepStaleSynthesisRuns(client);

    expect(errorInserts[0].message).not.toContain("crashed");
    expect(errorInserts[0].detail_json).toMatchObject({
      code: "synthesis_run_stale",
      failure_code: "synthesis_run_stale",
      attempt: 2,
      consecutive_failures: 2,
      max_fast_retries: 3,
      fast_retries_exhausted: false,
      sandbox_machine_id: "machine-9",
      swept_from_status: "running",
    });
    expect(typeof (errorInserts[0].detail_json as Record<string, unknown>).next_retry_at).toBe("string");
  });

  it("sweeps every workspace when no workspaceId is passed", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-g1", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(45) },
      { id: "run-g2", workspace_id: "workspace-b", status: "preparing", created_at: isoMinutesAgo(45) },
    ]);

    await sweepStaleSynthesisRuns(client);

    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("leaves a recent active-writer row untouched", async () => {
    const { client, rows, errorInserts } = createFakeClient([
      {
        id: "run-2",
        workspace_id: "workspace-a",
        status: "preparing",
        created_at: isoMinutesAgo(5),
      },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(0);
    expect(rows[0].status).toBe("preparing");
    expect(errorInserts).toHaveLength(0);
  });

  it("never touches rows in a terminal status regardless of age", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-3", workspace_id: "workspace-a", status: "succeeded", created_at: isoMinutesAgo(9999) },
      { id: "run-4", workspace_id: "workspace-a", status: "failed", created_at: isoMinutesAgo(9999) },
      { id: "run-5", workspace_id: "workspace-a", status: "stale", created_at: isoMinutesAgo(9999) },
      { id: "run-6", workspace_id: "workspace-a", status: "cancelled", created_at: isoMinutesAgo(9999) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept).toHaveLength(0);
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "failed", "stale", "cancelled"]);
  });

  it("sweeps validating and committing rows too, not just running", async () => {
    const { client } = createFakeClient([
      { id: "run-7", workspace_id: "workspace-a", status: "validating", created_at: isoMinutesAgo(45) },
      { id: "run-8", workspace_id: "workspace-a", status: "committing", created_at: isoMinutesAgo(45) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client);

    expect(swept.map((r) => r.id).sort()).toEqual(["run-7", "run-8"]);
  });

  it("scopes to the given workspace when workspaceId is passed", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-9", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(45) },
      { id: "run-10", workspace_id: "workspace-b", status: "running", created_at: isoMinutesAgo(45) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client, { workspaceId: "workspace-a" });

    expect(swept.map((r) => r.id)).toEqual(["run-9"]);
    expect(rows.find((r) => r.id === "run-9")?.status).toBe("failed");
    expect(rows.find((r) => r.id === "run-10")?.status).toBe("running");
  });

  it("respects a custom olderThanMs threshold", async () => {
    const { client, rows } = createFakeClient([
      { id: "run-11", workspace_id: "workspace-a", status: "running", created_at: isoMinutesAgo(3) },
    ]);

    const swept = await sweepStaleSynthesisRuns(client, { olderThanMs: 60_000 });

    expect(swept).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });
});
