import { queryOptions } from "@tanstack/react-query";
import type { DraftApi } from "./api";
import type { RoutineRun, RoutinesResponse } from "../routines/types";
import { queryKeys, routineRunsKey } from "./keys";

export const POLL_MS = 30_000;

// Freshness: polled data refreshes every 30s; context changes hourly at most.
export const STALE_MS = { runs: POLL_MS, context: 60_000, connections: 30_000, routines: 30_000 } as const;

// A run in progress is polled quickly so its status settles without a reload.
export const ROUTINE_RUN_POLL_MS = 3_000;
const anyRunning = (runs: RoutineRun[] | undefined) => runs?.some((run) => run.status === "running") ?? false;

export const runsQueryOptions = (api: DraftApi, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.runs(workspaceId),
    queryFn: () => api.getRuns(),
    staleTime: STALE_MS.runs,
    refetchInterval: POLL_MS,
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

export const routineRunsQueryOptions = (api: Pick<DraftApi, "getRoutineRuns">, workspaceId: string, routineId: string) =>
  queryOptions({
    queryKey: routineRunsKey(workspaceId, routineId),
    queryFn: () => api.getRoutineRuns(routineId),
    staleTime: ROUTINE_RUN_POLL_MS,
    refetchInterval: (query) => (anyRunning(query.state.data) ? ROUTINE_RUN_POLL_MS : STALE_MS.runs),
  });
