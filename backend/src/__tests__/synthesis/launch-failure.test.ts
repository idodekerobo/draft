import { describe, expect, it } from "bun:test";
import { recordLaunchFailure } from "../../synthesis/orchestrate-run";
import { RunPreparationFailedError } from "../../synthesis/prepare-run";
import { createFakeRunsClient, fakeRun } from "./fake-runs-client";

const RUN = "55555555-5555-4555-8555-555555555555";
const options = { workspaceId: "workspace-a", scheduledTaskId: undefined, triggerType: "manual" as const };

function setup() {
  return createFakeRunsClient({ agent_runs: [fakeRun({ id: RUN, status: "preparing" })] });
}

describe("a launch that fails at each stage", () => {
  for (const stage of ["bundle", "credential", "prompt", "sandbox", "mark_launched"]) {
    it(`${stage}: fails the run and writes an error row linked to it`, async () => {
      const { client, runs, errorInserts } = setup();
      await recordLaunchFailure({ client, runId: RUN, stage, options, error: new Error("boom") });

      expect(runs[0]).toMatchObject({ status: "failed", outcome: "failure", failure_code: `synthesis_launch_${stage}_failed` });
      expect(errorInserts).toHaveLength(1);
      expect(errorInserts[0]).toMatchObject({ agent_run_id: RUN, workspace_id: "workspace-a", operation: stage === "bundle" ? "queue" : "execution" });
    });
  }

  it("preparation, with no run yet: writes an error row with no run link", async () => {
    const { client, runs, errorInserts } = createFakeRunsClient({ agent_runs: [] });
    await recordLaunchFailure({ client, stage: "preparation", options, error: new Error("boom") });

    expect(runs).toHaveLength(0);
    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({ agent_run_id: null, operation: "queue" });
  });

  it("the bundle stage is a queue failure, like preparation", async () => {
    const { client, errorInserts } = setup();
    await recordLaunchFailure({ client, runId: RUN, stage: "bundle", options, error: new Error("boom") });
    expect(errorInserts[0]).toMatchObject({ operation: "queue" });
  });

  it("a run that is already finished is left alone and writes no second error", async () => {
    const { client, runs, errorInserts } = createFakeRunsClient({ agent_runs: [fakeRun({ id: RUN, status: "succeeded" })] });
    await recordLaunchFailure({ client, runId: RUN, stage: "sandbox", options, error: new Error("late") });
    expect(runs[0]).toMatchObject({ status: "succeeded" });
    expect(errorInserts).toHaveLength(0);
  });

  it("a preparation that failed after the row was made carries the run's id", () => {
    const cause = new Error("membership insert failed");
    const failure = new RunPreparationFailedError(RUN, cause);
    expect(failure.runId).toBe(RUN);
    expect(failure.cause).toBe(cause);
  });
});
