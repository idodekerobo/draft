import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { SynthesisRunSummary } from "../activity/ActivityList";
import type { DraftApi } from "./api";
import type { RoutineRun, RoutinesResponse } from "../routines/types";
import { queryKeys, routineRunsKey } from "./keys";

export const POLL_MS = 30_000;

// With signals from the server, polling is only a net for a missed signal.
export const SAFETY_POLL_MS = 300_000;

// Freshness: polled data refreshes every 30s; context changes hourly at most.
export const STALE_MS = { runs: POLL_MS, context: 60_000, connections: 30_000, routines: 30_000 } as const;

// A run in progress is polled quickly so its status settles without a reload.
export const ROUTINE_RUN_POLL_MS = 3_000;
const anyRunning = (runs: RoutineRun[] | undefined) => runs?.some((run) => run.status === "running") ?? false;

const ACTIVE_RUN = ["queued", "preparing", "running", "validating", "committing"];
const anyActive = (runs: SynthesisRunSummary[] | undefined) => runs?.some((run) => ACTIVE_RUN.includes(run.status)) ?? false;

export const runsQueryOptions = (api: DraftApi, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.runs(workspaceId),
    queryFn: () => api.getRuns(),
    staleTime: STALE_MS.runs,
    refetchInterval: (query) => anyActive(query.state.data) ? ROUTINE_RUN_POLL_MS : SAFETY_POLL_MS,
  });

/** How many runs the server sends per page. A shorter page is the last one. */
export const RUNS_PAGE_SIZE = 50;
export const runCursor = (run: Pick<SynthesisRunSummary, "createdAt" | "id">) => `${run.createdAt}|${run.id}`;

/** Every run, a page at a time, for the Activity list. Under the runs key, so a run signal refreshes it too. */
export const runHistoryQueryOptions = (api: DraftApi, workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.runs(workspaceId), "history"] as const,
    queryFn: ({ pageParam }) => api.getRuns(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.length === RUNS_PAGE_SIZE ? runCursor(page[page.length - 1]!) : undefined),
    staleTime: STALE_MS.runs,
    refetchInterval: (query) => anyActive(query.state.data?.pages[0]) ? ROUTINE_RUN_POLL_MS : SAFETY_POLL_MS,
  });

export const routinesQueryOptions = (api: Pick<DraftApi, "getRoutines">, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.routines(workspaceId),
    queryFn: () => api.getRoutines(),
    staleTime: STALE_MS.routines,
    refetchInterval: (query) =>
      anyRunning((query.state.data as RoutinesResponse | undefined)?.routines.flatMap((routine) => (routine.agent?.lastRun ? [routine.agent.lastRun] : [])))
        ? ROUTINE_RUN_POLL_MS
        : false,
  });

export const routineRunCursor = (run: Pick<RoutineRun, "startedAt" | "id">) => `${run.startedAt}|${run.id}`;

/** One routine's runs, a page at a time. A run in progress on the first page is polled quickly. */
export const routineRunsQueryOptions = (api: Pick<DraftApi, "getRoutineRuns">, workspaceId: string, routineId: string) =>
  infiniteQueryOptions({
    queryKey: routineRunsKey(workspaceId, routineId),
    queryFn: ({ pageParam }) => api.getRoutineRuns(routineId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.length === RUNS_PAGE_SIZE ? routineRunCursor(page[page.length - 1]!) : undefined),
    staleTime: ROUTINE_RUN_POLL_MS,
    refetchInterval: (query) => (anyRunning(query.state.data?.pages[0]) ? ROUTINE_RUN_POLL_MS : SAFETY_POLL_MS),
  });
