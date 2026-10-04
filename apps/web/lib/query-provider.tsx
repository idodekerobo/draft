"use client";

import {
  DraftQueryProvider,
  toRoutineError,
  type DraftApi,
  type Routine,
  type RoutinesResponse,
  type SynthesisRunSummary,
} from "draft-shared-ui";
import type { ReactNode } from "react";
import { apiFetch, ApiError } from "@/lib/api";

export function WebQueryProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const api: DraftApi = {
    getRuns: async () => (await apiFetch<{ runs: SynthesisRunSummary[] }>(`/workspaces/${workspaceId}/synthesis-runs`)).runs,
    getRoutines: () => apiFetch<RoutinesResponse>(`/workspaces/${workspaceId}/schedules`),
    updateRoutine: async (id, patch) => {
      try {
        return await apiFetch<Routine>(`/workspaces/${workspaceId}/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      } catch (error) {
        if (error instanceof ApiError) throw toRoutineError(error.code, error.field);
        throw error;
      }
    },
  };
  return <DraftQueryProvider api={api}>{children}</DraftQueryProvider>;
}
