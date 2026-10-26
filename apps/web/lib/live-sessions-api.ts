import { LiveSessionsDisabledError, type LiveSessionEventsPage, type LiveSessionsApi } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";

async function fetchLive<T>(path: string): Promise<T> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.code === "live_sessions_disabled") throw new LiveSessionsDisabledError();
    throw error;
  }
}

export function liveSessionsApi(workspaceId: string): LiveSessionsApi {
  const base = `/workspaces/${workspaceId}/live-sessions`;
  return {
    listSessions: async () => (await fetchLive<{ sessions: Awaited<ReturnType<LiveSessionsApi["listSessions"]>> }>(base)).sessions,
    fetchEvents: (sessionId, after) => fetchLive<LiveSessionEventsPage>(`${base}/${sessionId}/events?after=${after}`),
  };
}
