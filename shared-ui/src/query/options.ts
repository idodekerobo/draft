import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { SynthesisRunSummary } from "../activity/ActivityList";
import type { DraftApi } from "./api";
import type { RoutineRun, RoutinesResponse } from "../routines/types";
import { queryKeys, routineRunsKey, runDetailKey, runTranscriptKey } from "./keys";

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

/** The newest runs as a plain list, for the status bar. */
export const runsQueryOptions = (api: DraftApi, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.runs(workspaceId),
    queryFn: () => api.getRuns(),
    select: (page) => page.runs,
    staleTime: STALE_MS.runs,
    refetchInterval: (query) => anyActive(query.state.data?.runs) ? ROUTINE_RUN_POLL_MS : SAFETY_POLL_MS,
  });

/** How many runs the server sends per page. A shorter page is the last one. */
export const RUNS_PAGE_SIZE = 50;
export const runCursor = (run: Pick<SynthesisRunSummary, "createdAt" | "id">) => `${run.createdAt}|${run.id}`;

/** Every run, a page at a time, for the Activity list. Under the runs key, so a run signal refreshes it too. */
export const runHistoryQueryOptions = (api: DraftApi, workspaceId: string, mine = false) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.runs(workspaceId), "history", mine ? "mine" : "all"] as const,
    queryFn: ({ pageParam }) => (mine ? api.getRuns(pageParam, { mine: true }) : api.getRuns(pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: STALE_MS.runs,
    refetchInterval: (query) => anyActive(query.state.data?.pages[0]?.runs) ? ROUTINE_RUN_POLL_MS : query.state.data?.pages[0]?.upcoming?.length ? POLL_MS : SAFETY_POLL_MS,
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

/** One run with its steps. A run that is still going is polled quickly, so the steps settle without a reload. */
export const runDetailQueryOptions = (api: Pick<DraftApi, "getRunDetail">, workspaceId: string, runId: string) =>
  queryOptions({
    queryKey: runDetailKey(workspaceId, runId),
    queryFn: () => {
      if (!api.getRunDetail) throw new Error("This app cannot show a run's steps.");
      return api.getRunDetail(runId);
    },
    staleTime: STALE_MS.runs,
    refetchInterval: (query) => ACTIVE_RUN.includes(query.state.data?.status ?? "") ? ROUTINE_RUN_POLL_MS : false,
  });

/** What one step run did. A finished run's transcript does not change, so it is read once. */
export const runTranscriptQueryOptions = (api: Pick<DraftApi, "getRunTranscript">, workspaceId: string, runId: string) =>
  queryOptions({
    queryKey: runTranscriptKey(workspaceId, runId),
    queryFn: () => {
      if (!api.getRunTranscript) throw new Error("This app cannot show a transcript.");
      return api.getRunTranscript(runId);
    },
    staleTime: Infinity,
  });

/** What needs the person. Polled every 30 s and refetched on window focus. */
export const needsYouQueryOptions = (api: Pick<DraftApi, "getNeedsYou">, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.needsYou(workspaceId),
    queryFn: () => api.getNeedsYou(),
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
