import { LiveSessionsDisabledError, type LiveSessionsApi } from "draft-shared-ui";
import { rpc } from "./rpc";

export const liveSessionsApi: LiveSessionsApi = {
  listSessions: async () => {
    const { enabled, sessions } = await rpc.request.listLiveSessions();
    if (!enabled) throw new LiveSessionsDisabledError();
    return sessions;
  },
  fetchEvents: (sessionId, after) => rpc.request.getLiveSessionEvents({ sessionId, after }),
  sendMessage: async (sessionId, text) => {
    const result = await rpc.request.sendLiveSessionMessage({ sessionId, text });
    if (!result.ok) throw new Error(result.error);
  },
  listInputs: (sessionId) => rpc.request.listLiveSessionInputs({ sessionId }),
  actOnInput: (sessionId, inputId, action) => rpc.request.actOnLiveSessionInput({ sessionId, inputId, action }),
  decideApproval: async (sessionId, requestId, decision) => {
    const result = await rpc.request.decideLiveSessionApproval({ sessionId, requestId, decision });
    if (result.ok) return { ok: true };
    if (result.error === "already_decided") return { ok: false, error: "already_decided", byName: result.byName ?? null };
    if (result.error === "request_closed" || result.error === "session_ended") return { ok: false, error: result.error };
    return { ok: false, error: "failed" };
  },
  stop: async (sessionId) => {
    const result = await rpc.request.stopLiveSession({ sessionId });
    if (!result.ok) throw new Error(result.error);
  },
};
