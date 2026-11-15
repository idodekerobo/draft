import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RUNS_PAGE_SIZE, runCursor } from "../query/options";
import { ActivityPanel } from "./ActivityPanel";
import type { SynthesisRunSummary } from "./ActivityList";

afterEach(cleanup);

const run = (index: number): SynthesisRunSummary => ({
  id: `run-${index}`, kind: "routine", sessionId: `s-${index}`, routineTitle: `Routine ${index}`, status: "succeeded", outcome: null,
  triggerType: "manual", resultSummary: null, startedAt: null, completedAt: null, createdAt: new Date(Date.UTC(2026, 10, 14) - index * 60_000).toISOString(),
});

function renderPanel(getRuns: DraftApi["getRuns"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={{ getRuns } as DraftApi}>
        <ActivityPanel workspaceId="ws-1" onFixInConnections={() => {}} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
}

test("shows older runs a page at a time, asking for the runs before the last one shown", async () => {
  const first = Array.from({ length: RUNS_PAGE_SIZE }, (_, index) => run(index));
  const older = [run(RUNS_PAGE_SIZE), run(RUNS_PAGE_SIZE + 1)];
  const getRuns = mock(async (before?: string) => (before ? older : first));
  renderPanel(getRuns);

  fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
  await screen.findByText(`Routine ${RUNS_PAGE_SIZE + 1} · routine`);
  expect(getRuns).toHaveBeenLastCalledWith(runCursor(first[first.length - 1]!));
  // A short page is the last one.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull());
});

test("offers no older runs when everything fits on one page", async () => {
  renderPanel(async () => [run(0), run(1)]);
  await screen.findByText("Routine 1 · routine");
  expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
});
