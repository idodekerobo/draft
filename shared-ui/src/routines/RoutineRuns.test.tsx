import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RUNS_PAGE_SIZE, routineRunCursor } from "../query/options";
import { RoutineRuns } from "./RoutineRuns";
import type { Routine, RoutineRun } from "./types";

afterEach(cleanup);

const run = (index: number): RoutineRun => ({
  id: `run-${index}`, status: "completed", startedBy: { type: "schedule" }, startedAt: new Date(Date.UTC(2026, 10, 14) - index * 3_600_000).toISOString(), endedAt: null, result: `Result ${index}`,
});
const routine = { id: "t1", title: "Digest", timezone: "UTC" } as Routine;

test("shows a routine's older runs a page at a time", async () => {
  const first = Array.from({ length: RUNS_PAGE_SIZE }, (_, index) => run(index));
  const getRoutineRuns = mock(async (_id: string, before?: string) => (before ? [run(RUNS_PAGE_SIZE)] : first));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DraftApiProvider api={{ getRoutineRuns } as unknown as DraftApi}>
        <RoutineRuns workspaceId="ws-1" routine={routine} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
  await screen.findByText(`Result ${RUNS_PAGE_SIZE}`);
  expect(getRoutineRuns).toHaveBeenLastCalledWith("t1", routineRunCursor(first[first.length - 1]!));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull());
});
