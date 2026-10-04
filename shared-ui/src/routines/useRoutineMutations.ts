"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDraftApi } from "../query/api";
import { queryKeys } from "../query/keys";
import { useOptimisticMutation } from "../query/mutations";
import type { Routine, RoutinePatch, RoutinesResponse } from "./types";

function replaceRoutine(current: RoutinesResponse | undefined, updated: Routine): RoutinesResponse | undefined {
  return current && { ...current, routines: current.routines.map((row) => (row.id === updated.id ? updated : row)) };
}

export function useRoutineMutations(workspaceId: string, onToggleError: (error: Error) => void) {
  const api = useDraftApi();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.routines(workspaceId);

  const toggle = useOptimisticMutation<RoutinesResponse, { id: string; enabled: boolean }>({
    queryKey,
    mutationFn: async ({ id, enabled }) => {
      const updated = await api.updateRoutine(id, { enabled });
      const next = replaceRoutine(queryClient.getQueryData<RoutinesResponse>(queryKey), updated);
      if (!next) throw new Error("Routines are no longer loaded");
      return next;
    },
    apply: (current, { id, enabled }) =>
      current && {
        ...current,
        routines: current.routines.map((row) =>
          row.id === id ? { ...row, enabled, nextRunAt: enabled ? row.nextRunAt : null } : row,
        ),
      },
    onError: onToggleError,
  });

  const save = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RoutinePatch }) => api.updateRoutine(id, patch),
    onSuccess: (updated) => queryClient.setQueryData<RoutinesResponse | undefined>(queryKey, (current) => replaceRoutine(current, updated)),
  });

  return { toggle, save };
}
