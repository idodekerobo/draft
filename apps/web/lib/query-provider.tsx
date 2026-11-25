"use client";

import {
  DraftQueryProvider,
  slackChannelsFromConnections,
  toRoutineError,
  type ConnectionsListAnswer,
  type DraftApi,
  type NeedsYou,
  type Routine,
  type RoutineRun,
  type RoutineRunOutcome,
  type RoutinesResponse,
  type SynthesisRunsPage,
  type RunDetail,
  type StepRunTranscript,
} from "draft-shared-ui";
import type { ReactNode } from "react";
import { useAnalytics } from "./analytics/AnalyticsProvider";
import { apiFetch, ApiError } from "@/lib/api";

export function WebQueryProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const { track } = useAnalytics();
  const api: DraftApi = {
    getRuns: (before) => apiFetch<SynthesisRunsPage>(`/workspaces/${workspaceId}/synthesis-runs${before ? `?before=${encodeURIComponent(before)}` : ""}`),
    getNeedsYou: async () => (await apiFetch<{ output: NeedsYou }>(`/workspaces/${workspaceId}/tools/home.needs_you`, { method: "POST", body: "{}" })).output,
    actOnNotification: async (id, action) => {
      try {
        const answer = await apiFetch<{ output: { state: "open" | "done" | "not_mine" | "retracted"; changed: boolean } }>(`/workspaces/${workspaceId}/tools/notifications.${action}`, { method: "POST", body: JSON.stringify({ notificationId: id }) });
        return { ok: true, state: answer.output.state, changed: answer.output.changed };
      } catch (error) {
        if (error instanceof ApiError && typeof error.detail?.message === "string") return { ok: false, code: typeof error.detail.code === "string" ? error.detail.code : error.code, message: error.detail.message };
        throw error;
      }
    },
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
      return slackChannelsFromConnections(await apiFetch<ConnectionsListAnswer>(`/workspaces/${workspaceId}/tools/connections.list`, { method: "POST", body: JSON.stringify({ provider: "slack" }) }));
    },
    getRoutineGithubRepos: async () => (await apiFetch<{ repos: string[] }>(`/workspaces/${workspaceId}/routine-repositories`)).repos,
    getRunDetail: (runId) => apiFetch<RunDetail>(`/workspaces/${workspaceId}/runs/${runId}`),
    getRunTranscript: (runId) => apiFetch<StepRunTranscript>(`/workspaces/${workspaceId}/runs/${runId}/transcript`),
    getRoutineRuns: async (id, before) => (await apiFetch<{ runs: RoutineRun[] }>(`/workspaces/${workspaceId}/schedules/${id}/runs${before ? `?before=${encodeURIComponent(before)}` : ""}`)).runs,
  };
  return <DraftQueryProvider api={api} track={track}>{children}</DraftQueryProvider>;
}
