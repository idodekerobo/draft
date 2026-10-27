import { LiveSessionsDisabledError, type ApprovalResult, type LiveSessionEventsPage, type LiveSessionInput, type LiveSessionsApi } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";

async function fetchLive<T>(path: string): Promise<T> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.code === "live_sessions_disabled") throw new LiveSessionsDisabledError();
    throw error;
  }
}

async function post(path: string, body: unknown): Promise<void> {
  try {
    await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    // The composer maps these codes to messages.
    if (error instanceof ApiError) throw new Error(error.code);
    throw error;
  }
}

async function decide(path: string, decision: "allow" | "deny"): Promise<ApprovalResult> {
  try {
    await apiFetch(path, { method: "POST", body: JSON.stringify({ decision }) });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError)) return { ok: false, error: "failed" };
    if (error.code === "already_decided") return { ok: false, error: "already_decided", byName: typeof error.detail?.by_name === "string" ? error.detail.by_name : null };
    if (error.code === "request_closed" || error.code === "session_ended") return { ok: false, error: error.code };
    return { ok: false, error: "failed" };
  }
}

export function liveSessionsApi(workspaceId: string): LiveSessionsApi {
  const base = `/workspaces/${workspaceId}/live-sessions`;
  return {
    listSessions: async () => (await fetchLive<{ sessions: Awaited<ReturnType<LiveSessionsApi["listSessions"]>> }>(base)).sessions,
    fetchEvents: (sessionId, after) => fetchLive<LiveSessionEventsPage>(`${base}/${sessionId}/events?after=${after}`),
    sendMessage: (sessionId, text) => post(`${base}/${sessionId}/inputs`, { text }),
    listInputs: async (sessionId) => (await fetchLive<{ inputs: LiveSessionInput[] }>(`${base}/${sessionId}/inputs`)).inputs,
    actOnInput: (sessionId, inputId, action) => post(`${base}/${sessionId}/inputs/${inputId}`, { action }),
    decideApproval: (sessionId, requestId, decision) => decide(`${base}/${sessionId}/approvals/${encodeURIComponent(requestId)}/decision`, decision),
    stop: (sessionId) => post(`${base}/${sessionId}/stop`, {}),
  };
}
