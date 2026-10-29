import { SessionNotFoundError, toApprovalResult, type ApprovalResult, type LiveSessionEventsPage, type LiveSessionsApi } from "draft-shared-ui";
import { presenceChannel, presenceNames, type PresenceMeta } from "draft-core/live-sessions";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

async function fetchLive<T>(path: string): Promise<T> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.code === "session_not_found") throw new SessionNotFoundError();
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
    return toApprovalResult(error.code, typeof error.detail?.by_name === "string" ? error.detail.by_name : null);
  }
}

export function liveSessionsApi(workspaceId: string): LiveSessionsApi {
  const base = `/workspaces/${workspaceId}/live-sessions`;
  return {
    listSessions: async () => (await fetchLive<{ sessions: Awaited<ReturnType<LiveSessionsApi["listSessions"]>> }>(base)).sessions,
    fetchEvents: (sessionId, after) => fetchLive<LiveSessionEventsPage>(`${base}/${sessionId}/events?after=${after}`),
    sendMessage: (sessionId, text) => post(`${base}/${sessionId}/inputs`, { text }),
    actOnInput: (sessionId, inputId, action) => post(`${base}/${sessionId}/inputs/${inputId}`, { action }),
    decideApproval: (sessionId, requestId, decision) => decide(`${base}/${sessionId}/approvals/${encodeURIComponent(requestId)}/decision`, decision),
    stop: (sessionId) => post(`${base}/${sessionId}/stop`, {}),
    watchPresence: (sessionId, viewer, onChange) => {
      const client = createClient();
      const channel = client.channel(presenceChannel(sessionId), { config: { private: true, presence: { key: viewer.id } } });
      channel
        .on("presence", { event: "sync" }, () => onChange(presenceNames(channel.presenceState<PresenceMeta>(), viewer.id)))
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void channel.track({ name: viewer.name });
        });
      return () => void client.removeChannel(channel);
    },
  };
}
