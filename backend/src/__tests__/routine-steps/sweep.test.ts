import { describe, expect, it } from "bun:test";
import { advanceWorkflow } from "../../routine-steps/advance";
import { advanceStuckWorkflows, failStrandedParents, sweepStaleStepRuns } from "../../routine-steps/sweep";
import { sweepStaleSynthesisRuns } from "../../synthesis/reconcile-stale-runs";
import { RoutineLeaseBusyError } from "../../metaharness/sandbox/launch-with-credentials";
import { CONFIG, PARENT, children, endRun, items, parentRow, setup, step } from "./harness";

const LONG_AGO = "2026-11-25T00:00:00.000Z";
const NOW = new Date("2026-11-26T12:00:00.000Z");
const opts = (h: ReturnType<typeof setup>) => ({ now: NOW, resolveWorkflow: () => h.workflow, launch: h.deps.launch });

async function started(options: Parameters<typeof setup>[0]) {
  const h = setup(options);
  await advanceWorkflow(h.deps, PARENT);
  return h;
}

describe("sweeping step runs", () => {
  it("fails a step run that has been going too long, then retries it", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    children(h)[0]!.updated_at = LONG_AGO;
    expect(await sweepStaleStepRuns(h.client, CONFIG, opts(h))).toEqual([children(h)[0]!.id as string]);
    const [first, retry] = children(h);
    expect(first).toMatchObject({ status: "failed", failure_code: "step_run_stale" });
    expect(retry).toMatchObject({ attempt: 2, status: "running" });
  });

  it("fails the parent when a run goes stale for the last time", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    children(h)[0]!.updated_at = LONG_AGO;
    await sweepStaleStepRuns(h.client, CONFIG, opts(h));
    children(h).find((run) => run.attempt === 2)!.updated_at = LONG_AGO;
    await sweepStaleStepRuns(h.client, CONFIG, opts(h));
    expect(parentRow(h)).toMatchObject({ status: "failed" });
    expect(h.failed[0]!.code).toBe("step_failed");
  });

  it("leaves a recent run, and a queued run that waited a long time, alone", async () => {
    const h = await started({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(2) } });
    const [running, queued] = children(h);
    running!.updated_at = "2026-11-26T11:50:00.000Z";
    queued!.updated_at = LONG_AGO;
    expect(await sweepStaleStepRuns(h.client, CONFIG, opts(h))).toEqual([]);
    expect(running!.status).toBe("running");
    expect(queued!.status).toBe("queued");
  });
});

describe("moving stuck workflows on", () => {
  it("starts a run the Codex login held back once the login is free", async () => {
    const h = setup({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(1) } });
    h.failNextLaunch(new RoutineLeaseBusyError());
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h)[0]!.status).toBe("queued");
    expect(await advanceStuckWorkflows(h.client, CONFIG, opts(h))).toBe(1);
    expect(children(h)[0]!.status).toBe("running");
    expect(h.launched).toHaveLength(1);
  });

  it("finishes a run whose last callback never moved it on", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    endRun(h, h.launched[0]!, { status: "succeeded", result: {} });
    await advanceStuckWorkflows(h.client, CONFIG, opts(h));
    expect(parentRow(h).status).toBe("succeeded");
    expect(h.finished).toHaveLength(1);
  });

  it("ignores runs that have no steps", async () => {
    const h = setup({ steps: [step("capture")], parent: { result_json: null } });
    expect(await advanceStuckWorkflows(h.client, CONFIG, opts(h))).toBe(0);
  });
});

describe("a parent with nothing left to wait for", () => {
  it("is failed when it has steps left and nothing can start", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) }, parent: { updated_at: LONG_AGO } });
    // A workflow whose plan keeps coming back with something that never gets created is stuck: here, a plan that errors every pass.
    h.workflow.plan = async () => { throw new Error("cannot plan"); };
    await expect(failStrandedParents(h.client, CONFIG, opts(h))).rejects.toThrow("cannot plan");
  });

  it("is left alone while a step run is queued or going", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) }, parent: { updated_at: LONG_AGO } });
    expect(await failStrandedParents(h.client, CONFIG, opts(h))).toEqual([]);
    expect(parentRow(h).status).toBe("running");
  });

  it("is left alone while a retry waits out its backoff", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) }, parent: { updated_at: LONG_AGO } });
    h.setNow(new Date());
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "failed", code: "claude_error", category: "rate_limit" });
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h).find((run) => run.attempt === 2)!.status).toBe("queued");
    expect(await failStrandedParents(h.client, CONFIG, { now: new Date(Date.now() + 60 * 60_000), resolveWorkflow: () => h.workflow, launch: h.deps.launch })).toEqual([]);
    expect(parentRow(h).status).toBe("running");
  });

  it("is not touched while it is recent", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    endRun(h, h.launched[0]!, { status: "succeeded", result: {} });
    expect(await failStrandedParents(h.client, CONFIG, { now: new Date("2026-11-26T00:05:00.000Z"), resolveWorkflow: () => h.workflow, launch: h.deps.launch })).toEqual([]);
  });
});

describe("the age sweep of plain synthesis runs", () => {
  it("fails an old run with no steps, and leaves an old run that has steps to the step sweep", async () => {
    const h = setup({ steps: [step("capture")], parent: { created_at: LONG_AGO } });
    h.db.tables.agent_runs!.push({ id: "55555555-5555-4555-8555-555555555555", workspace_id: "11111111-1111-4111-8111-111111111111", kind: "synthesis", status: "running", result_json: null, created_at: LONG_AGO, harness: "claude", attempt: 1 });
    const swept = await sweepStaleSynthesisRuns(h.client);
    expect(swept.map((run) => run.id)).toEqual(["55555555-5555-4555-8555-555555555555"]);
    expect(parentRow(h).status).toBe("running");
  });
});
