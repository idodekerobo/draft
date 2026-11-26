import { describe, expect, it } from "bun:test";
import { getRunDetail, getStepRunTranscript } from "../../activity/run-detail";
import { activityClient } from "./activity-fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PARENT = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const steps = [
  { key: "capture", prompt: "c", model: null, permissions: [], fanOut: { over: "none" }, output: { type: "text" } },
  { key: "reconcile", prompt: "r", model: null, permissions: [], fanOut: { over: "none" }, output: { type: "text" } },
  { key: "organize", prompt: "o", model: null, permissions: [], fanOut: { over: "none" }, output: { type: "text" } },
];
type Row = Record<string, unknown>;

const parent = (overrides: Row = {}): Row => ({ id: PARENT, workspace_id: WS, kind: "synthesis", status: "running", outcome: null, summary: null, scheduled_task_id: null, parent_run_id: null, started_at: "2026-11-26T01:00:00.000Z", completed_at: null, failure_code: null, result_json: { steps }, ...overrides });
const child = (id: string, stepKey: string, overrides: Row = {}): Row => ({ id, workspace_id: WS, kind: "step", parent_run_id: PARENT, step_key: stepKey, status: "succeeded", attempt: 1, step_item: { key: id, type: "none" }, summary: null, failure_code: null, started_at: "2026-11-26T01:01:00.000Z", completed_at: "2026-11-26T01:02:00.000Z", usage_json: null, transcript_json: null, execution: { adapterId: "claude-print" }, created_at: `2026-11-26T01:0${stepKey === "capture" ? 1 : stepKey === "reconcile" ? 2 : 3}:00.000Z`, ...overrides });
const doc = (sha: string) => ({ content: "x", sha256: sha });

const client = (tables: Record<string, Row[]>) => activityClient({ scheduled_tasks: [], workspace_context_versions: [], ...tables });
const detail = (tables: Record<string, Row[]>, viewer: string | null = ME) => getRunDetail(client(tables), WS, PARENT, viewer);

describe("the detail of a run with steps", () => {
  it("lists the steps in order with the runs each started, and what is still to come as waiting", async () => {
    const result = await detail({ agent_runs: [parent(), child("c1", "capture", { step_item: { key: "batch-1", type: "source_batch", sourceCount: 3 }, summary: "Three facts" })] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.steps.map((step) => [step.key, step.status])).toEqual([["capture", "done"], ["reconcile", "waiting"], ["organize", "waiting"]]);
    expect(result.detail.steps[0]!.runs[0]).toMatchObject({ id: "c1", label: "3 sources", summary: "Three facts", attempt: 1 });
  });

  it("shows a run that failed halfway: what finished, which step failed, and what never ran", async () => {
    const result = await detail({ agent_runs: [
      parent({ status: "failed", outcome: "failure", failure_code: "step_failed", summary: "Step reconcile failed", completed_at: "2026-11-26T01:10:00.000Z" }),
      child("c1", "capture"),
      child("r1", "reconcile", { status: "failed", failure_code: "claude_exit", step_item: { key: "doc:a.md", type: "document", path: "a.md" } }),
    ] });
    if (!result.ok) throw new Error("expected a detail");
    expect(result.detail.steps.map((step) => [step.key, step.status])).toEqual([["capture", "done"], ["reconcile", "failed"], ["organize", "not_run"]]);
    expect(result.detail.failedStep).toBe("reconcile");
    expect(result.detail.steps[1]!.runs[0]).toMatchObject({ label: "a.md", failureCode: "claude_exit" });
  });

  it("marks steps a finished run had no work for as skipped, and a step that is going as running", async () => {
    const finished = await detail({ agent_runs: [parent({ status: "succeeded", outcome: "no_change" }), child("c1", "capture")] });
    if (!finished.ok) throw new Error("expected a detail");
    expect(finished.detail.steps.map((step) => step.status)).toEqual(["done", "skipped", "skipped"]);
    const going = await detail({ agent_runs: [parent(), child("c1", "capture"), child("r1", "reconcile", { status: "running", completed_at: null })] });
    if (!going.ok) throw new Error("expected a detail");
    expect(going.detail.steps.map((step) => step.status)).toEqual(["done", "running", "waiting"]);
  });

  it("counts a step that lost some runs as done when the run carried on, and shows the retries", async () => {
    const result = await detail({ agent_runs: [
      parent({ status: "succeeded", outcome: "changed" }),
      child("c1", "capture", { step_item: { key: "batch-1", type: "source_batch", sourceCount: 1 } }),
      child("c2", "capture", { status: "failed", attempt: 1, step_item: { key: "batch-2", type: "source_batch", sourceCount: 1 } }),
      child("c3", "capture", { status: "failed", attempt: 2, step_item: { key: "batch-2", type: "source_batch", sourceCount: 1 } }),
    ] });
    if (!result.ok) throw new Error("expected a detail");
    expect(result.detail.steps[0]).toMatchObject({ status: "done" });
    expect(result.detail.steps[0]!.runs.map((run) => [run.id, run.attempt])).toEqual([["c1", 1], ["c2", 1], ["c3", 2]]);
  });

  it("adds up the tokens, and names the documents each run changed", async () => {
    const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, costUsd: 0.5 };
    const result = await detail({
      agent_runs: [parent({ status: "succeeded", outcome: "changed" }), child("c1", "capture", { usage_json: usage }), child("r1", "reconcile", { usage_json: usage })],
      workspace_context_versions: [
        { id: "v1", agent_run_id: null, previous_version_id: null, documents_json: { "a.md": doc("a1"), "b.md": doc("b1") } },
        { id: "v2", agent_run_id: "r1", previous_version_id: "v1", documents_json: { "a.md": doc("a2"), "b.md": doc("b1"), "c.md": doc("c1") } },
      ],
    });
    if (!result.ok) throw new Error("expected a detail");
    expect(result.detail.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 0, costUsd: 1 });
    expect(result.detail.steps[1]!.runs[0]!.documentsChanged).toEqual(["a.md", "c.md"]);
    expect(result.detail.documentsChanged).toEqual(["a.md", "c.md"]);
  });

  it("shows a run from before steps existed with no steps", async () => {
    const result = await detail({ agent_runs: [parent({ result_json: null })] });
    if (!result.ok) throw new Error("expected a detail");
    expect(result.detail.steps).toEqual([]);
  });

  it("does not open a step run, another workspace's run, or a missing run", async () => {
    expect((await detail({ agent_runs: [child("c1", "capture")] })).ok).toBe(false);
    expect((await detail({ agent_runs: [parent({ workspace_id: "99999999-9999-4999-8999-999999999999" })] })).ok).toBe(false);
    expect((await detail({ agent_runs: [] })).ok).toBe(false);
  });

  it("does not open the run of another person's private routine", async () => {
    const tables = { agent_runs: [parent({ kind: "routine", scheduled_task_id: TASK })], scheduled_tasks: [{ id: TASK, workspace_id: WS, config_json: { title: "Mine" }, schedule_kind: "cron", visibility: "private", created_by_user_id: OTHER }] };
    expect((await detail(tables, ME)).ok).toBe(false);
    const owner = await detail(tables, OTHER);
    expect(owner.ok && owner.detail.routineTitle).toBe("Mine");
    const shared = await detail({ ...tables, scheduled_tasks: [{ ...tables.scheduled_tasks[0]!, visibility: "shared" }] }, ME);
    expect(shared.ok).toBe(true);
  });
});

describe("what a step run did", () => {
  const claudeMessages = [
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "I read the sources." }] } },
    { type: "result", is_error: false, result: "done" },
  ];
  const withRun = (overrides: Row = {}) => ({ agent_runs: [parent(), child("c1", "capture", { transcript_json: claudeMessages, ...overrides })] });

  it("gives what the agent said as plain lines", async () => {
    const transcript = await getStepRunTranscript(client(withRun()), WS, "c1", ME);
    expect(transcript?.lines).toEqual(["Agent: I read the sources."]);
    expect(transcript?.truncated).toBe(false);
  });

  it("gives nothing for a run with no transcript, and none for a run the viewer may not open", async () => {
    const empty = await getStepRunTranscript(client(withRun({ transcript_json: null })), WS, "c1", ME);
    expect(empty).toEqual({ lines: [], truncated: false });
    expect(await getStepRunTranscript(client({ agent_runs: [parent()] }), WS, PARENT, ME)).toBeNull();
    const privateRoutine = { agent_runs: [parent({ kind: "routine", scheduled_task_id: TASK }), child("c1", "capture", { transcript_json: claudeMessages })], scheduled_tasks: [{ id: TASK, workspace_id: WS, config_json: {}, schedule_kind: "cron", visibility: "private", created_by_user_id: OTHER }] };
    expect(await getStepRunTranscript(client(privateRoutine), WS, "c1", ME)).toBeNull();
  });

  it("cuts a very long transcript and says so", async () => {
    const many = Array.from({ length: 450 }, (_, index) => ({ type: "assistant", uuid: `a${index}`, message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }] } }));
    const transcript = await getStepRunTranscript(client(withRun({ transcript_json: many })), WS, "c1", ME);
    expect(transcript?.lines).toHaveLength(400);
    expect(transcript?.truncated).toBe(true);
  });
});
