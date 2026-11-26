import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RunDetailView, describeFailure, describeUsage, stepLabel } from "./RunDetailView";
import type { RunDetail, StepRunDetail } from "./run-detail-types";

afterEach(() => { cleanup(); mock.restore(); });

const usage = { inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 0.07 };
const stepRun = (overrides: Partial<StepRunDetail> = {}): StepRunDetail => ({
  id: "r1", status: "succeeded", attempt: 1, label: "", startedAt: "2026-11-26T01:00:00.000Z", completedAt: "2026-11-26T01:00:42.000Z", summary: null, failureCode: null, usage: null, documentsChanged: [], hasTranscript: false, ...overrides,
});
const run = (overrides: Partial<RunDetail> = {}): RunDetail => ({
  id: "run-1", kind: "synthesis", status: "succeeded", outcome: "changed", summary: "Updated two documents.", routineId: null, routineTitle: null,
  startedAt: "2026-11-26T01:00:00.000Z", completedAt: "2026-11-26T01:05:00.000Z", failureCode: null, failedStep: null, usage: usage, documentsChanged: ["company/about.md"],
  steps: [
    { key: "capture", status: "done", runs: [stepRun({ id: "c1", label: "3 sources", summary: "Three facts" })] },
    { key: "reconcile", status: "done", runs: [stepRun({ id: "r1", label: "company/about.md", documentsChanged: ["company/about.md"] })] },
    { key: "organize", status: "done", runs: [stepRun({ id: "o1" })] },
  ], ...overrides,
});

function renderView(api: Partial<DraftApi>, onBack = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api as DraftApi}>
        <RunDetailView workspaceId="ws-1" runId="run-1" onBack={onBack} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
}

test("says it is loading, then shows the run's title, state and each step in order", async () => {
  renderView({ getRunDetail: async () => run() });
  expect(screen.getByRole("status").textContent).toContain("Loading this run");
  await screen.findByRole("heading", { name: "Context update" });
  expect(screen.getByText(/Completed, Nov 26/)).toBeTruthy();
  const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem").filter((item) => item.classList.contains("ui-run-step"));
  expect(steps.map((item) => item.querySelector(".ui-run-step__name")!.textContent)).toEqual(["Capture", "Reconcile", "Organize"]);
  expect(steps.map((item) => item.querySelector(".ui-run-step__status")!.textContent)).toEqual(["Done", "Done", "Done"]);
  expect(screen.getByText("Updated two documents.")).toBeTruthy();
});

test("uses the routine's own title, and a plain word for a custom step", async () => {
  renderView({ getRunDetail: async () => run({ kind: "routine", routineTitle: "Weekly digest", steps: [{ key: "draft_reply", status: "done", runs: [] }] }) });
  await screen.findByRole("heading", { name: "Weekly digest" });
  expect(screen.getByText("Draft reply")).toBeTruthy();
  expect(stepLabel("draft_reply")).toBe("Draft reply");
  expect(stepLabel("capture")).toBe("Capture");
});

test("a run that failed halfway says where it stopped, what finished and what stays", async () => {
  renderView({ getRunDetail: async () => run({
    status: "failed", outcome: "failure", failedStep: "reconcile", documentsChanged: ["memory/days/2026-11-26.md"], summary: "Step reconcile failed",
    steps: [
      { key: "capture", status: "done", runs: [stepRun({ id: "c1" })] },
      { key: "reconcile", status: "failed", runs: [stepRun({ id: "r1", status: "failed", attempt: 2, label: "company/about.md", failureCode: "claude_exit" })] },
      { key: "organize", status: "not_run", runs: [] },
    ],
  }) });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Stopped at the reconcile step");
  expect(alert.textContent).toContain("1 of 3 steps finished");
  expect(alert.textContent).toContain("Documents already updated stay updated: memory/days/2026-11-26.md");
  expect(alert.textContent).toContain("Sources that were not read stay pending for the next run.");
  // The failed step is open already, so the reason is in view.
  expect(screen.getByText("The agent stopped before it finished.")).toBeTruthy();
  expect(screen.getByText(/Attempt 2/)).toBeTruthy();
  expect(screen.getByText("Not run")).toBeTruthy();
  expect(screen.getByText("Failed", { selector: ".ui-run-step__status" })).toBeTruthy();
});

test("says no documents changed when a failed run changed none, and does not promise a retry for a routine", async () => {
  renderView({ getRunDetail: async () => run({ kind: "routine", routineTitle: "Digest", status: "failed", failedStep: "collect", documentsChanged: [], steps: [{ key: "collect", status: "failed", runs: [] }] }) });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("No documents were changed.");
  expect(alert.textContent).not.toContain("pending for the next run");
});

test("shows a run that is going with steps waiting, and no documents yet", async () => {
  renderView({ getRunDetail: async () => run({ status: "running", outcome: null, summary: null, completedAt: null, documentsChanged: [], usage: null, steps: [
    { key: "capture", status: "running", runs: [stepRun({ id: "c1", status: "running", completedAt: null })] },
    { key: "reconcile", status: "waiting", runs: [] },
    { key: "organize", status: "waiting", runs: [] },
  ] }) });
  await screen.findByText(/In progress/);
  expect(screen.getAllByText("Waiting")).toHaveLength(2);
  expect(screen.getByText("Running")).toBeTruthy();
  expect(screen.getByText("None yet")).toBeTruthy();
});

test("shows a step the run had no work for as skipped", async () => {
  renderView({ getRunDetail: async () => run({ steps: [{ key: "capture", status: "done", runs: [stepRun()] }, { key: "reconcile", status: "skipped", runs: [] }] }) });
  await screen.findByText("Skipped, nothing to do");
});

test("a step's runs open and close, and show what each did, the documents changed and the tokens used", async () => {
  renderView({ getRunDetail: async () => run({ steps: [{ key: "reconcile", status: "done", runs: [stepRun({ id: "r1", label: "company/about.md", usage, documentsChanged: ["company/about.md"], summary: "Updated the headcount" })] }] }) });
  const toggle = await screen.findByRole("button", { name: /Show 1 run/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("company/about.md", { selector: ".ui-run-step__run-label" })).toBeTruthy();
  // Once on the run, and once in the whole run's total.
  expect(screen.getAllByText(/2,000 tokens in, 340 out, about \$0.07/)).toHaveLength(2);
  expect(screen.getByText("Changed company/about.md")).toBeTruthy();
  expect(screen.getByText("Updated the headcount")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByText("Updated the headcount")).toBeNull();
});

test("shows the tokens for the whole run, and the documents it changed", async () => {
  renderView({ getRunDetail: async () => run({ documentsChanged: ["a.md", "b.md"] }) });
  await screen.findByText("Documents changed");
  expect(screen.getByText("a.md, b.md")).toBeTruthy();
  expect(screen.getByText(/2,000 tokens in, 340 out/)).toBeTruthy();
});

test("a run from before steps existed says so", async () => {
  renderView({ getRunDetail: async () => run({ steps: [] }) });
  await screen.findByText("This run did not use steps.");
});

test("reads what a step run did on request, and says when it saved nothing", async () => {
  const getRunTranscript = mock(async () => ({ lines: ["Agent: I read the sources.", "Tool sources.read: {}"], truncated: true }));
  renderView({ getRunDetail: async () => run({ steps: [{ key: "capture", status: "done", runs: [stepRun({ hasTranscript: true })] }] }), getRunTranscript });
  fireEvent.click(await screen.findByRole("button", { name: /Show 1 run/ }));
  expect(getRunTranscript).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show what it did" }));
  const transcript = await screen.findByLabelText("Transcript");
  expect(transcript.textContent).toBe("Agent: I read the sources.\nTool sources.read: {}");
  expect(screen.getByText("Only the first part is shown.")).toBeTruthy();
  expect(getRunTranscript).toHaveBeenCalledWith("r1");
  fireEvent.click(screen.getByRole("button", { name: "Hide what it did" }));
  expect(screen.queryByLabelText("Transcript")).toBeNull();
});

test("a transcript that cannot load offers to try again", async () => {
  let calls = 0;
  const getRunTranscript = mock(async () => { calls += 1; if (calls === 1) throw new Error("down"); return { lines: ["Agent: ok"], truncated: false }; });
  renderView({ getRunDetail: async () => run({ steps: [{ key: "capture", status: "done", runs: [stepRun({ hasTranscript: true })] }] }), getRunTranscript });
  fireEvent.click(await screen.findByRole("button", { name: /Show 1 run/ }));
  fireEvent.click(screen.getByRole("button", { name: "Show what it did" }));
  await screen.findByText(/Could not load what it did/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Transcript");
});

test("a run that cannot load says so and can try again", async () => {
  let calls = 0;
  const getRunDetail = mock(async () => { calls += 1; if (calls === 1) throw new Error("down"); return run(); });
  renderView({ getRunDetail });
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load this run");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Context update" });
});

test("an app that cannot show steps says so instead of loading for ever", async () => {
  renderView({});
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load this run");
});

test("Back goes back to Activity", async () => {
  const onBack = mock(() => {});
  renderView({ getRunDetail: async () => run() }, onBack);
  fireEvent.click(await screen.findByRole("button", { name: "Back to Activity" }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("describes failures and usage in plain words", () => {
  expect(describeFailure("step_run_stale")).toBe("It did not report back in time.");
  expect(describeFailure("codex_exit")).toBe("The agent stopped before it finished.");
  expect(describeFailure("weird_code")).toBe("It failed (weird_code).");
  expect(describeFailure(null)).toBe("It did not finish.");
  expect(describeUsage(null)).toBeNull();
  expect(describeUsage({ ...usage, costUsd: null })).toBe("2,000 tokens in, 340 out");
});

test("waits for the run to settle: a run in progress is read again", async () => {
  const getRunDetail = mock(async () => run({ status: "running", outcome: null, completedAt: null, steps: [] }));
  renderView({ getRunDetail });
  await screen.findByText(/In progress/);
  await waitFor(() => expect(getRunDetail.mock.calls.length).toBeGreaterThanOrEqual(1));
});
