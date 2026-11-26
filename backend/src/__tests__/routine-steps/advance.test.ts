import { afterEach, describe, expect, it } from "bun:test";
import { RoutineLeaseBusyError } from "../../metaharness/sandbox/launch-with-credentials";
import { advanceWorkflow } from "../../routine-steps/advance";
import { onParentRunFinished } from "../../routine-steps/parent-finished";
import { VERSION_2, PARENT, WS, children, endRun, items, parentRow, setup, step } from "./harness";

const stopListening: Array<() => void> = [];
afterEach(() => stopListening.splice(0).forEach((stop) => stop()));

describe("starting a step", () => {
  it("queues one run for each planned item and starts as many as the harness allows", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(6) } });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("waiting");
    const runs = children(h, "capture");
    expect(runs).toHaveLength(6);
    expect(runs.every((run) => run.kind === "step" && run.parent_run_id === PARENT && run.attempt === 1)).toBe(true);
    expect(runs.filter((run) => run.status === "running")).toHaveLength(4);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(2);
    expect(h.launched).toHaveLength(4);
  });

  it("starts Codex runs one at a time", async () => {
    const h = setup({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(3) } });
    await advanceWorkflow(h.deps, PARENT);
    expect(h.launched).toHaveLength(1);
    endRun(h, h.launched[0]!, { status: "succeeded" });
    await advanceWorkflow(h.deps, PARENT);
    expect(h.launched).toHaveLength(2);
    expect(children(h).filter((run) => run.status === "queued")).toHaveLength(1);
  });

  it("gives each run the step's prompt, tools and the parent's identity", async () => {
    const h = setup({ steps: [step("capture", { prompt: "Capture the facts." })], plans: { capture: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    const [run] = children(h);
    expect(run).toMatchObject({ kind: "step", instructions: "Capture the facts.", step_key: "capture", harness: "claude", workspace_id: WS, on_behalf_of_user_id: null, prompt_version: "synthesis-v3" });
    expect(run!.trigger).toEqual({ type: "step", parentRunId: PARENT, parentKind: "synthesis" });
    expect(run!.permissions).toEqual([{ tool: "context.read" }]);
    expect(run!.step_item).toEqual({ key: "item-1", type: "none" });
  });

  it("saves the sources a run reads as that run's own membership", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => [{ item: { key: "batch-1", type: "source_batch", sourceCount: 2 }, membership: [{ sourceItemId: "s1", version: "v1", contentHash: "a".repeat(64) }, { sourceItemId: "s2", version: "v1", contentHash: "b".repeat(64) }] }] } });
    await advanceWorkflow(h.deps, PARENT);
    const rows = h.db.tables.agent_run_source_items!;
    expect(rows.map((row) => [row.agent_run_id === children(h)[0]!.id, row.source_item_id, row.position])).toEqual([[true, "s1", 0], [true, "s2", 1]]);
  });

  it("starts a run on the newest context version when it waited in the queue", async () => {
    const h = setup({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(2) } });
    await advanceWorkflow(h.deps, PARENT);
    h.db.tables.workspaces![0]!.current_context_version_id = VERSION_2;
    endRun(h, h.launched[0]!, { status: "succeeded" });
    await advanceWorkflow(h.deps, PARENT);
    expect(h.launchedFrom.get(h.launched[1]!)).toBe(VERSION_2);
  });

  it("starts nothing for a parent that has ended, or that has no saved steps", async () => {
    const ended = setup({ steps: [step("capture")], parent: { status: "succeeded" } });
    expect(await advanceWorkflow(ended.deps, PARENT)).toBe("inactive");
    expect(ended.launched).toEqual([]);
    const noSteps = setup({ steps: [], parent: { result_json: {} } });
    expect(await advanceWorkflow(noSteps.deps, PARENT)).toBe("failed");
    expect(noSteps.failed[0]!.code).toBe("workflow_steps_missing");
  });
});

describe("advancing", () => {
  it("plans the next step only when every run of the one before has succeeded, and hands it their answers", async () => {
    let seen: unknown;
    const h = setup({
      steps: [step("capture"), step("reconcile")],
      plans: { capture: () => items(2), reconcile: (ctx) => { seen = ctx.outputs.capture!.map((entry) => entry.result); return items(1, "doc"); } },
    });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "succeeded", result: { entries: ["a"] } });
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h, "reconcile")).toHaveLength(0);
    endRun(h, h.launched[1]!, { status: "succeeded", result: { entries: ["b"] } });
    await advanceWorkflow(h.deps, PARENT);
    expect(seen).toEqual([{ entries: ["a"] }, { entries: ["b"] }]);
    expect(children(h, "reconcile")).toHaveLength(1);
    expect(h.launched).toHaveLength(3);
  });

  it("skips the steps after one that has nothing to do, and finishes", async () => {
    const h = setup({ steps: [step("capture"), step("reconcile"), step("organize")], plans: { capture: () => [], reconcile: () => [], organize: () => [] } });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("finished");
    expect(children(h)).toHaveLength(0);
    expect(h.finished).toEqual([{ outputs: { capture: [], reconcile: [], organize: [] }, runs: 0 }]);
    expect(parentRow(h).status).toBe("succeeded");
  });

  it("finishes once, with every step's answers, when the last run succeeds", async () => {
    const h = setup({ steps: [step("capture"), step("organize")], plans: { capture: () => items(1), organize: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "succeeded", result: { n: 1 } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[1]!, { status: "succeeded", result: { done: true } });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("finished");
    expect(h.finished).toEqual([{ outputs: { capture: [{ n: 1 }], organize: [{ done: true }] }, runs: 2 }]);
    // A second call, such as the scheduler's, finds the run ended and does nothing.
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("inactive");
    expect(h.finished).toHaveLength(1);
  });

  it("plans and starts each run once when two callbacks advance at the same time", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(3) } });
    await Promise.all([advanceWorkflow(h.deps, PARENT), advanceWorkflow(h.deps, PARENT), advanceWorkflow(h.deps, PARENT)]);
    expect(children(h)).toHaveLength(3);
    expect(new Set(h.launched).size).toBe(h.launched.length);
    expect(h.launched).toHaveLength(3);
  });

  it("finishes once when two callbacks both see the last run done", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "succeeded" });
    const states = await Promise.all([advanceWorkflow(h.deps, PARENT), advanceWorkflow(h.deps, PARENT)]);
    expect(states).toContain("finished");
    expect(h.finished).toHaveLength(1);
  });
});

describe("failures", () => {
  it("retries a failed run once, for the same item and sources, and starts it at once", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => [{ item: { key: "batch-1", type: "source_batch", sourceCount: 1 }, membership: [{ sourceItemId: "s1", version: "v1", contentHash: "a".repeat(64) }] }] } });
    await advanceWorkflow(h.deps, PARENT);
    const first = children(h)[0]!;
    endRun(h, first.id as string, { status: "failed", code: "claude_exit" });
    await advanceWorkflow(h.deps, PARENT);
    const runs = children(h);
    expect(runs).toHaveLength(2);
    const retry = runs.find((run) => run.attempt === 2)!;
    expect(retry).toMatchObject({ retry_of_run_id: first.id, status: "running", step_key: "capture" });
    expect(retry.step_item).toEqual({ key: "batch-1", type: "source_batch", sourceCount: 1 });
    expect(h.db.tables.agent_run_source_items!.filter((row) => row.agent_run_id === retry.id).map((row) => row.source_item_id)).toEqual(["s1"]);
  });

  it("fails the parent when a run fails again after its retry", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "failed", code: "claude_exit" });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[1]!, { status: "failed", code: "claude_exit" });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("failed");
    expect(h.failed).toEqual([{ code: "step_failed", reason: expect.stringContaining("Step capture failed") }]);
    expect(h.finished).toEqual([]);
    expect(children(h)).toHaveLength(2);
  });

  it("cancels the runs still queued when the parent fails, so nothing starts after it", async () => {
    const h = setup({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(3) } });
    await advanceWorkflow(h.deps, PARENT);
    // The first run has used its attempts. The other two are still waiting for the one Codex login.
    Object.assign(children(h)[0]!, { status: "failed", attempt: 2, failure_code: "codex_exit", completed_at: new Date().toISOString() });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("failed");
    expect(children(h).map((run) => run.status).sort()).toEqual(["cancelled", "cancelled", "failed"]);
    expect(h.launched).toHaveLength(1);
  });

  it("waits out a rate limit before it retries, and allows three attempts", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) } });
    h.setNow(new Date("2026-11-26T01:00:00.000Z"));
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "failed", code: "claude_error", category: "rate_limit" });
    await advanceWorkflow(h.deps, PARENT);
    // The first rate limit waits five minutes from when it failed (01:00).
    expect(children(h).find((run) => run.attempt === 2)!.status).toBe("queued");
    h.setNow(new Date("2026-11-26T01:04:00.000Z"));
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h).find((run) => run.attempt === 2)!.status).toBe("queued");
    h.setNow(new Date("2026-11-26T01:05:30.000Z"));
    await advanceWorkflow(h.deps, PARENT);
    const second = children(h).find((run) => run.attempt === 2)!;
    expect(second.status).toBe("running");
    endRun(h, second.id as string, { status: "failed", code: "claude_error", category: "rate_limit" });
    await advanceWorkflow(h.deps, PARENT);
    const third = children(h).find((run) => run.attempt === 3)!;
    expect(third.status).toBe("queued");
    h.setNow(new Date("2026-11-26T01:25:00.000Z"));
    await advanceWorkflow(h.deps, PARENT);
    expect(third.status).toBe("running");
    endRun(h, third.id as string, { status: "failed", code: "claude_error", category: "rate_limit" });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("failed");
    expect(children(h)).toHaveLength(3);
  });

  it("lets a step with allowPartial pass when some of its runs succeeded", async () => {
    const h = setup({ steps: [step("capture", { allowPartial: true }), step("organize")], plans: { capture: () => items(2), organize: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    const [a, b] = h.launched as [string, string];
    endRun(h, a, { status: "succeeded", result: { ok: true } });
    endRun(h, b, { status: "failed", code: "claude_exit" });
    await advanceWorkflow(h.deps, PARENT);
    // b is retried once and fails again.
    endRun(h, h.launched[2]!, { status: "failed", code: "claude_exit" });
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h, "organize")).toHaveLength(1);
    expect(h.failed).toEqual([]);
  });

  it("fails the parent when every run of an allowPartial step failed", async () => {
    const h = setup({ steps: [step("capture", { allowPartial: true })], plans: { capture: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "failed", code: "claude_exit" });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[1]!, { status: "failed", code: "claude_exit" });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("failed");
    expect(h.failed[0]!.code).toBe("step_failed");
  });

  it("leaves a run queued, and fails nothing, when the workspace's Codex login is busy", async () => {
    const h = setup({ harness: "codex", steps: [step("capture")], plans: { capture: () => items(1) } });
    h.failNextLaunch(new RoutineLeaseBusyError());
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("waiting");
    expect(children(h)[0]!.status).toBe("queued");
    expect(h.db.tables.errors).toHaveLength(0);
    await advanceWorkflow(h.deps, PARENT);
    expect(children(h)[0]!.status).toBe("running");
  });

  it("fails a run whose launch fails, then retries it", async () => {
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) } });
    h.failNextLaunch(new Error("fly is down"));
    await advanceWorkflow(h.deps, PARENT);
    const runs = children(h);
    expect(runs.find((run) => run.attempt === 1)).toMatchObject({ status: "failed", failure_code: "step_launch_failed" });
    expect(runs.find((run) => run.attempt === 2)!.status).toBe("running");
  });
});

describe("the finished hook", () => {
  it("tells a listener once, with the parent run's id, kind, workspace, status, outcome and owner, and never for a step run", async () => {
    const seen: unknown[] = [];
    stopListening.push(onParentRunFinished((run) => { seen.push(run); }));
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) }, parent: { on_behalf_of_user_id: "33333333-3333-4333-8333-333333333333" } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "succeeded", result: {} });
    await advanceWorkflow(h.deps, PARENT);
    await advanceWorkflow(h.deps, PARENT);
    expect(seen).toEqual([{ id: PARENT, kind: "synthesis", workspace_id: WS, status: "succeeded", outcome: "no_change", on_behalf_of_user_id: "33333333-3333-4333-8333-333333333333" }]);
  });

  it("tells a listener when the parent run fails", async () => {
    const seen: Array<{ status: string }> = [];
    stopListening.push(onParentRunFinished((run) => { seen.push(run); }));
    const h = setup({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[0]!, { status: "failed" });
    await advanceWorkflow(h.deps, PARENT);
    endRun(h, h.launched[1]!, { status: "failed" });
    await advanceWorkflow(h.deps, PARENT);
    expect(seen).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("does not let a failing listener change the run", async () => {
    stopListening.push(onParentRunFinished(() => { throw new Error("listener broke"); }));
    const h = setup({ steps: [step("capture")], plans: { capture: () => [] } });
    expect(await advanceWorkflow(h.deps, PARENT)).toBe("finished");
    expect(parentRow(h).status).toBe("succeeded");
  });
});
