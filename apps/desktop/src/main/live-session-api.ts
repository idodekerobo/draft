import type { ApprovalResponse, LiveSession, LiveSessionEventsPage, LiveSessionInput } from "draft-core/live-sessions";
import { hostServices, ServerError } from "draft-core/host/services";
import { sessionBase } from "draft-core/host/live-session";

export async function listLiveSessions(): Promise<LiveSession[]> {
  const workspaceId = hostServices().workspaceId();
  if (!workspaceId) return [];
  const body = await hostServices().fetchServerJSON<{ sessions: LiveSession[] }>(`workspaces/${workspaceId}/live-sessions`);
  return body.sessions;
}

export async function getLiveSessionEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage> {
  return hostServices().fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=${after}`);
}

export async function sendLiveSessionMessage(sessionId: string, text: string): Promise<{ ok: true; input?: LiveSessionInput } | { ok: false; error: string }> {
  try {
    const body = await hostServices().fetchServerJSON<{ input?: LiveSessionInput }>(`${sessionBase(sessionId)}/inputs`, { method: "POST", body: JSON.stringify({ text }) });
    return { ok: true, input: body.input };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "send_failed" };
  }
}

export async function actOnLiveSessionInput(sessionId: string, inputId: string, action: "resend" | "dismiss" | "steer" | "cancel"): Promise<void> {
  await hostServices().fetchServer(`${sessionBase(sessionId)}/inputs/${inputId}`, { method: "POST", body: JSON.stringify({ action }) });
}

/** Sends a teammate's decision on an open permission request. */
export async function decideLiveSessionApproval(
  sessionId: string,
  requestId: string,
  response: ApprovalResponse,
): Promise<{ ok: true } | { ok: false; error: string; byName?: string | null; reason?: string | null }> {
  try {
    await hostServices().fetchServer(`${sessionBase(sessionId)}/approvals/${encodeURIComponent(requestId)}/decision`, { method: "POST", body: JSON.stringify(response) });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ServerError)) return { ok: false, error: "decision_failed" };
    const detail = (error.detail ?? {}) as { by_name?: string | null; reason?: string | null };
    return { ok: false, error: error.code, byName: detail.by_name ?? null, reason: detail.reason ?? null };
  }
}

export async function setLiveSessionMode(sessionId: string, change: { permissionMode?: string; approvalMode?: string; model?: string | null; reasoningEffort?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hostServices().fetchServer(`${sessionBase(sessionId)}/mode`, { method: "POST", body: JSON.stringify(change) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "mode_failed" };
  }
}

export async function stopLiveSession(sessionId: string, keepQueued = false): Promise<{ ok: true; withdrawn: string[] } | { ok: false; error: string }> {
  try {
    const response = await hostServices().fetchServer(`${sessionBase(sessionId)}/stop`, { method: "POST", body: JSON.stringify(keepQueued ? { keepQueued: true } : {}) });
    const body = (await response.json().catch(() => ({}))) as { withdrawn?: Array<{ text: string }> };
    return { ok: true, withdrawn: (body.withdrawn ?? []).map((input) => input.text) };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "stop_failed" };
  }
}
