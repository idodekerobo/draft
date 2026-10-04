"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDraftApi } from "../query/api";
import { queryKeys } from "../query/keys";
import { useOptimisticMutation } from "../query/mutations";
import type { Routine, RoutinePatch, RoutinesResponse } from "./types";

function mapRoutine(
  current: RoutinesResponse | undefined,
  id: string,
  change: (row: Routine) => Routine,
): RoutinesResponse | undefined {
  return current && { ...current, routines: current.routines.map((row) => (row.id === id ? change(row) : row)) };
}

export function useRoutineMutations(workspaceId: string, onToggleError: (error: Error) => void) {
  const api = useDraftApi();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.routines(workspaceId);

  const toggle = useOptimisticMutation<RoutinesResponse, { id: string; enabled: boolean }>({
    queryKey,
    mutationFn: async ({ id, enabled }) => {
      const updated = await api.updateRoutine(id, { enabled });
      const next = mapRoutine(queryClient.getQueryData<RoutinesResponse>(queryKey), id, () => updated);
      if (!next) throw new Error("Routines are no longer loaded");
      return next;
    },
    apply: (current, { id, enabled }) =>
      mapRoutine(current, id, (row) => ({ ...row, enabled, nextRunAt: enabled ? row.nextRunAt : null })),
    onError: onToggleError,
  });

  const save = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RoutinePatch }) => api.updateRoutine(id, patch),
    onSuccess: (updated) => queryClient.setQueryData<RoutinesResponse | undefined>(queryKey, (current) => mapRoutine(current, updated.id, () => updated)),
  });

  return { toggle, save };
}
