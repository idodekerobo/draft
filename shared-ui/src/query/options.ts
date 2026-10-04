import { queryOptions } from "@tanstack/react-query";
import type { DraftApi } from "./api";
import { queryKeys } from "./keys";

export const POLL_MS = 30_000;

// Freshness: polled data refreshes every 30s; context changes hourly at most.
export const STALE_MS = { runs: POLL_MS, context: 60_000, connections: 30_000, routines: 30_000 } as const;

export const runsQueryOptions = (api: DraftApi, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.runs(workspaceId),
    queryFn: () => api.getRuns(),
    staleTime: STALE_MS.runs,
    refetchInterval: POLL_MS,
  });

export const routinesQueryOptions = (api: DraftApi, workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.routines(workspaceId),
    queryFn: () => api.getRoutines(),
    staleTime: STALE_MS.routines,
  });
