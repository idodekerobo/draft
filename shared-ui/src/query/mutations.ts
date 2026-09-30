"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";

/** Update cached data at once, roll back if the save fails. */
export function useOptimisticMutation<TData, TVariables>({ queryKey, mutationFn, apply, onError }: {
  queryKey: QueryKey;
  mutationFn: (variables: TVariables) => Promise<TData>;
  apply: (current: TData | undefined, variables: TVariables) => TData | undefined;
  onError?: (error: Error) => void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (variables: TVariables) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TData>(queryKey);
      queryClient.setQueryData<TData | undefined>(queryKey, (current) => apply(current, variables));
      return { previous };
    },
    onError: (error, _variables, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      onError?.(error);
    },
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });
}

/** Refetch a query. Resolves true when it succeeded, for panels that expect a boolean. */
export function useRefreshQuery(queryKey: QueryKey): () => Promise<boolean> {
  const queryClient = useQueryClient();
  const keyHash = JSON.stringify(queryKey);
  return useCallback(async () => {
    try {
      await queryClient.refetchQueries({ queryKey: JSON.parse(keyHash) as QueryKey, exact: true }, { throwOnError: true });
      return true;
    } catch {
      return false;
    }
  }, [queryClient, keyHash]);
}
