import { describe, expect, it, mock } from "bun:test";
import { retryFailedSynthesisRuns } from "../../synthesis/retry-failed-runs";
import { retryPlan } from "../../synthesis/handle-run-failure";
import { RunNotAllowedError } from "../../synthesis/check-run-allowed";
import { createFakeRunsClient, fakeRun, type FakeRunRow } from "./fake-runs-client";

const now = new Date("2026-10-02T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

function setup(runs: FakeRunRow[], options: { pending?: string[]; launch?: (...args: never[]) => unknown } = {}) {
  const { client } = createFakeRunsClient({
    synthesis_runs: runs,
    workspaces: [
      { id: "workspace-a", runs_enabled: true, max_runs_per_day: null, inference_credential_id: "cred" },
    ],
  });
  const launch = mock(options.launch ?? (async () => ({ runId: "new", machineId: "m", bundleHash: "h" })));
  const getPendingSourceItemIds = mock(async () => options.pending ?? ["item-1"]);
  const run = () =>
    retryFailedSynthesisRuns({
      client,
      config: {} as never,
      now,
      launch: launch as never,
      getPendingSourceItemIds: getPendingSourceItemIds as never,
    });
  return { run, launch, getPendingSourceItemIds };
}

describe("retryPlan", () => {
  const completedAt = new Date("2026-10-02T12:00:00.000Z");

  it.each([
    [1, 5],
    [2, 10],
    [3, 15],
  ])("waits the backoff after attempt %i", (attempt, minutes) => {
    const plan = retryPlan(attempt, completedAt);
    expect(plan.exhausted).toBe(false);
    expect(plan.nextRetryAt?.getTime()).toBe(completedAt.getTime() + minutes * 60_000);
  });

  it("is exhausted from attempt 4 on", () => {
    expect(retryPlan(4, completedAt)).toEqual({ nextRetryAt: null, exhausted: true });
    expect(retryPlan(7, completedAt).exhausted).toBe(true);
  });
});

describe("retryFailedSynthesisRuns", () => {
  it("retries a failed run once its backoff has elapsed", async () => {
    const { run, launch } = setup([fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(6) })]);

    expect(await run()).toEqual(["f1"]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace-a",
      triggerType: "retry",
      retryOfRunId: "f1",
      sourceItemIds: ["item-1"],
    });
  });

  it("does not retry before the backoff elapses", async () => {
    const { run, launch } = setup([fakeRun({ id: "f1", attempt: 2, completed_at: minutesAgo(9) })]);

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses the longer backoff for later attempts", async () => {
    const { run } = setup([fakeRun({ id: "f3", attempt: 3, completed_at: minutesAgo(16) })]);

    expect(await run()).toEqual(["f3"]);
  });

  it("does not retry after attempt 4 failed", async () => {
    const { run, launch } = setup([fakeRun({ id: "f4", attempt: 4, completed_at: minutesAgo(60) })]);

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not retry a failure older than the retry window", async () => {
    const { run, launch } = setup([fakeRun({ id: "old", attempt: 1, completed_at: minutesAgo(180) })]);

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not retry a run superseded by a newer run", async () => {
    const { run, launch } = setup([
      fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(20), created_at: minutesAgo(25) }),
      fakeRun({ id: "newer", status: "succeeded", created_at: minutesAgo(10) }),
    ]);

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not retry a run that already has a retry", async () => {
    const { run, launch } = setup([
      fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(20), created_at: minutesAgo(25) }),
      fakeRun({ id: "retry-1", status: "running", attempt: 2, retry_of_run_id: "f1", created_at: minutesAgo(10) }),
    ]);

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not retry when nothing is pending", async () => {
    const { run, launch } = setup([fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(6) })], {
      pending: [],
    });

    expect(await run()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not count a denied launch as a retry", async () => {
    const { run, launch } = setup([fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(6) })], {
      launch: async () => {
        throw new RunNotAllowedError("workspace-a", "paused");
      },
    });

    expect(await run()).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("swallows an unexpected launch failure (already recorded by launchSynthesisRun)", async () => {
    let calls = 0;
    const { run } = setup([fakeRun({ id: "f1", attempt: 1, completed_at: minutesAgo(6) })], {
      launch: async () => {
        calls += 1;
        throw new Error("fly down");
      },
    });

    expect(await run()).toEqual([]);
    expect(calls).toBe(1);
  });
});
