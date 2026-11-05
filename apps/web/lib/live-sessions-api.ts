import { SessionNotFoundError, toApprovalResult, type ApprovalResponse, type ApprovalResult, type LiveSessionEventsPage, type LiveSessionsApi } from "draft-shared-ui";
import { presenceChannel, presenceNames, type PresenceMeta } from "draft-core/live-sessions";
import { ApiError, apiFetch } from "@/lib/api";
import { createSignalWatcher } from "@/lib/signals";
import { createClient } from "@/lib/supabase/client";

const signals = createSignalWatcher(createClient);
export const watchSignals = signals.watch;

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

async function decide(path: string, response: ApprovalResponse): Promise<ApprovalResult> {
  try {
    await apiFetch(path, { method: "POST", body: JSON.stringify(response) });
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
    decideApproval: (sessionId, requestId, response) => decide(`${base}/${sessionId}/approvals/${encodeURIComponent(requestId)}/decision`, response),
    setMode: (sessionId, change) => post(`${base}/${sessionId}/mode`, change),
    stop: async (sessionId, options) => {
      try {
        const result = await apiFetch<{ withdrawn?: Array<{ text: string }> }>(`${base}/${sessionId}/stop`, { method: "POST", body: JSON.stringify(options?.keepQueued ? { keepQueued: true } : {}) });
        return { withdrawn: (result.withdrawn ?? []).map((input) => input.text) };
      } catch (error) {
        if (error instanceof ApiError) throw new Error(error.code);
        throw error;
      }
    },
    watchSignals,
    watchConnection: signals.watchConnection,
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
