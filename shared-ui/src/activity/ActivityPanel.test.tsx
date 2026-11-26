import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RUNS_PAGE_SIZE, runCursor } from "../query/options";
import { ActivityPanel } from "./ActivityPanel";
import { toast } from "../toast";
import type { UpcomingRoutine, SynthesisRunSummary } from "./ActivityList";

afterEach(() => { cleanup(); mock.restore(); });

const run = (index: number): SynthesisRunSummary => ({
  id: `run-${index}`, kind: "routine", sessionId: `s-${index}`, routineTitle: `Routine ${index}`, status: "succeeded", outcome: null,
  triggerType: "manual", resultSummary: null, startedAt: null, completedAt: null, createdAt: new Date(Date.UTC(2026, 10, 14) - index * 60_000).toISOString(),
});

function renderPanel(getRuns: DraftApi["getRuns"], api: Partial<DraftApi> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={{ getRuns, ...api } as DraftApi}>
        <ActivityPanel workspaceId="ws-1" onFixInConnections={() => {}} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
}

test("shows older runs a page at a time, asking for the runs before the last one shown", async () => {
  const first = Array.from({ length: RUNS_PAGE_SIZE }, (_, index) => run(index));
  const older = [run(RUNS_PAGE_SIZE), run(RUNS_PAGE_SIZE + 1)];
  const getRuns = mock(async (before?: string) => (before ? { runs: older, nextCursor: null } : { runs: first, nextCursor: runCursor(first[first.length - 1]!) }));
  renderPanel(getRuns);

  fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
  await screen.findByText(`Routine ${RUNS_PAGE_SIZE + 1} · routine`);
  expect(getRuns).toHaveBeenLastCalledWith(runCursor(first[first.length - 1]!));
  // A short page is the last one.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Show older runs" }) === null).toBe(true));
});

test("offers no older runs when everything fits on one page", async () => {
  renderPanel(async () => ({ runs: [run(0), run(1)], nextCursor: null }));
  await screen.findByText("Routine 1 · routine");
  expect(screen.queryByRole("button", { name: "Show older runs" }) === null).toBe(true);
});

const upcomingRoutine = (id: string): UpcomingRoutine => ({ id, title: `Check ${id}`, runAt: "2026-12-01T09:00:00Z", timezone: "UTC", setBy: { type: "person", name: "Idode" } });

test("upcoming shows timing and who set it; cancelling removes only that row and focuses the next action", async () => {
  let upcoming = [upcomingRoutine("first"), { ...upcomingRoutine("second"), setBy: { type: "routine" as const, routineId: "parent", title: "Daily review" } }];
  const deleted = mock(async (id: string) => { upcoming = upcoming.filter((row) => row.id !== id); });
  const success = spyOn(toast, "success");
  renderPanel(async () => ({ runs: [], nextCursor: null, upcoming }), { deleteRoutine: deleted });
  const cancel = await screen.findByRole("button", { name: "Cancel Check first" });
  expect(screen.getByText(/set by Idode/)).toBeTruthy();
  expect(screen.getByText(/set by Daily review/)).toBeTruthy();
  cancel.focus();
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel Check first" }) === null).toBe(true));
  expect(deleted).toHaveBeenCalledWith("first");
  await waitFor(() => expect(document.activeElement === screen.getByRole("button", { name: "Cancel Check second" })).toBe(true));
  expect(success).toHaveBeenCalledWith("Cancelled");
  fireEvent.click(screen.getByRole("button", { name: "Cancel Check second" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Upcoming" }) === null).toBe(true));
  expect(document.activeElement === screen.getByRole("heading", { name: "Runs" })).toBe(true);
});

test("a failed cancellation keeps the row and shows the server message without a success toast", async () => {
  const error = spyOn(toast, "error");
  const success = spyOn(toast, "success");
  renderPanel(async () => ({ runs: [], nextCursor: null, upcoming: [upcomingRoutine("first")] }), { deleteRoutine: async () => { throw new Error("Cancellation unavailable. Try later."); } });
  fireEvent.click(await screen.findByRole("button", { name: "Cancel Check first" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("Cancellation unavailable. Try later."));
  expect(screen.getByRole("button", { name: "Cancel Check first" })).toBeTruthy();
  expect(success).not.toHaveBeenCalled();
});

test("run again starts a one-shot and a failed outcome never claims success", async () => {
  const once = { ...run(0), routineKind: "once" as const, routineId: "task" };
  const start = mock(async () => ({ status: "started" as const, runId: "new", sessionId: "new-session" }));
  const success = spyOn(toast, "success");
  renderPanel(async () => ({ runs: [once], nextCursor: null }), { runRoutine: start });
  fireEvent.click(await screen.findByRole("button", { name: "Run Routine 0 again" }));
  await waitFor(() => expect(success).toHaveBeenCalledWith("Started"));
  expect(start).toHaveBeenCalledWith("task");
  cleanup();
  success.mockClear();
  const error = spyOn(toast, "error");
  renderPanel(async () => ({ runs: [once], nextCursor: null }), { runRoutine: async () => ({ status: "failed" }) });
  fireEvent.click(await screen.findByRole("button", { name: "Run Routine 0 again" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("The run could not start. Try again."));
  expect(success).not.toHaveBeenCalled();
  expect(screen.getByText("Routine 0 · routine")).toBeTruthy();
});

test("queued and rejected runs show their actual outcome", async () => {
  const info = spyOn(toast, "info");
  const error = spyOn(toast, "error");
  const success = spyOn(toast, "success");
  let fail = false;
  renderPanel(async () => ({ runs: [{ ...run(0), routineKind: "once", routineId: "task" }], nextCursor: null }), { runRoutine: async () => { if (fail) throw new Error("Your login needs reconnecting."); return { status: "queued" }; } });
  fireEvent.click(await screen.findByRole("button", { name: "Run Routine 0 again" }));
  await waitFor(() => expect(info).toHaveBeenCalledWith("Queued. It runs when the current run ends."));
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Run Routine 0 again" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("Your login needs reconnecting."));
  expect(success).not.toHaveBeenCalled();
});

test("empty upcoming is hidden and a failed upcoming read preserves runs and offers retry", async () => {
  let failed = true;
  renderPanel(async () => ({ runs: [run(0)], nextCursor: null, upcoming: [], ...(failed ? { upcomingError: true as const } : {}) }));
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load upcoming routines");
  expect(screen.getByText("Routine 0 · routine")).toBeTruthy();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Upcoming" }) === null).toBe(true));
});

test("loading exposes upcoming and activity failures offer a retry", async () => {
  let reject!: (error: Error) => void;
  renderPanel(() => new Promise((_resolve, fail) => { reject = fail; }));
  expect(screen.getByRole("heading", { name: "Upcoming" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Loading activity…");
  reject(new Error("Offline"));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load activity");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("created recurring routines open the editor; created one-shots open their latest run", async () => {
  const onOpenRun = mock(() => {});
  const onOpenRoutine = mock(() => {});
  const getRoutineRuns = mock(async () => [{ id: "child-session", status: "completed" as const, startedAt: "2026-11-16T10:00:00Z", endedAt: null }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DraftApiProvider api={{ getRuns: async () => ({ runs: [{ ...run(0), createdRoutines: [{ id: "child", title: "Follow up", kind: "once" }, { id: "daily", title: "Daily", kind: "recurring" }] }], nextCursor: null }), getRoutineRuns } as unknown as DraftApi}><ActivityPanel workspaceId="ws-1" onFixInConnections={() => {}} onOpenRun={onOpenRun} onOpenRoutine={onOpenRoutine} /></DraftApiProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Daily" }));
  expect(onOpenRoutine).toHaveBeenCalledWith("daily");
  fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
  await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith("child-session"));
  expect(getRoutineRuns).toHaveBeenCalledWith("child");
});

test("a run with steps offers View steps, opens them, and Back returns focus to that button", async () => {
  const withSteps = { ...run(0), kind: "synthesis" as const, sessionId: null, routineTitle: null, stepCount: 3, triggerType: "schedule" };
  const getRunDetail = mock(async () => ({
    id: "run-0", kind: "synthesis", status: "succeeded", outcome: "no_change" as const, summary: null, routineId: null, routineTitle: null, startedAt: null, completedAt: null,
    failureCode: null, failedStep: null, usage: null, documentsChanged: [], steps: [{ key: "capture", status: "done" as const, runs: [] }],
  }));
  renderPanel(async () => ({ runs: [withSteps, run(1)], nextCursor: null }), { getRunDetail });
  // Only the run that has steps offers them.
  const buttons = await screen.findAllByRole("button", { name: /View steps/ });
  expect(buttons).toHaveLength(1);
  buttons[0]!.focus();
  fireEvent.click(buttons[0]!);
  await screen.findByRole("heading", { name: "Context update" });
  expect(getRunDetail).toHaveBeenCalledWith("run-0");
  expect(screen.queryByRole("heading", { name: "Runs" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Activity" }));
  const back = await screen.findByRole("button", { name: /View steps/ });
  await waitFor(() => expect(document.activeElement).toBe(back));
});
