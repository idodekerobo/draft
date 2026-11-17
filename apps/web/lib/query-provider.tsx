"use client";

import {
  DraftQueryProvider,
  toRoutineError,
  type DraftApi,
  type Routine,
  type RoutineRun,
  type RoutineRunOutcome,
  type RoutinesResponse,
  type SynthesisRunsPage,
} from "draft-shared-ui";
import type { ReactNode } from "react";
import { apiFetch, ApiError } from "@/lib/api";

export function WebQueryProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const api: DraftApi = {
    getRuns: (before) => apiFetch<SynthesisRunsPage>(`/workspaces/${workspaceId}/synthesis-runs${before ? `?before=${encodeURIComponent(before)}` : ""}`),
    getRoutines: () => apiFetch<RoutinesResponse>(`/workspaces/${workspaceId}/schedules`),
    updateRoutine: async (id, patch) => {
      try {
        return await apiFetch<Routine>(`/workspaces/${workspaceId}/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      } catch (error) {
        if (error instanceof ApiError) throw toRoutineError(error.code, error.field);
        throw error;
      }
    },
    createRoutine: async (input) => {
      try {
        return await apiFetch<Routine>(`/workspaces/${workspaceId}/schedules`, { method: "POST", body: JSON.stringify(input) });
      } catch (error) {
        if (error instanceof ApiError) throw toRoutineError(error.code, error.field);
        throw error;
      }
    },
    deleteRoutine: async (id) => {
      try {
        await apiFetch<null>(`/workspaces/${workspaceId}/schedules/${id}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof ApiError) throw new Error(typeof error.detail?.message === "string" ? error.detail.message : toRoutineError(error.code, error.field).message);
        throw error;
      }
    },
    runRoutine: async (id) => {
      try {
        return (await apiFetch<{ outcome: RoutineRunOutcome }>(`/workspaces/${workspaceId}/schedules/${id}/run`, { method: "POST" })).outcome;
      } catch (error) {
        if (error instanceof ApiError) throw new Error(typeof error.detail?.message === "string" ? error.detail.message : toRoutineError(error.code, error.field).message);
        throw error;
      }
    },
    getRoutineSlackChannels: async () => {
      const result = await apiFetch<{ status: string; output?: Array<{ id: string; name: string }>; message?: string }>(`/workspaces/${workspaceId}/tools/slack.list_channels`, { method: "POST", body: "{}" });
      if (result.status !== "ok" || !result.output) throw new Error(result.message ?? "Could not load Slack channels.");
      return result.output;
    },
    getRoutineGithubRepos: async () => (await apiFetch<{ repos: string[] }>(`/workspaces/${workspaceId}/routine-repositories`)).repos,
    getRoutineRuns: async (id, before) => (await apiFetch<{ runs: RoutineRun[] }>(`/workspaces/${workspaceId}/schedules/${id}/runs${before ? `?before=${encodeURIComponent(before)}` : ""}`)).runs,
  };
  return <DraftQueryProvider api={api}>{children}</DraftQueryProvider>;
}
