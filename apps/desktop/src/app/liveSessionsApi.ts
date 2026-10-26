import { LiveSessionsDisabledError, type LiveSessionsApi } from "draft-shared-ui";
import { rpc } from "./rpc";

export const liveSessionsApi: LiveSessionsApi = {
  listSessions: async () => {
    const { enabled, sessions } = await rpc.request.listLiveSessions();
    if (!enabled) throw new LiveSessionsDisabledError();
    return sessions;
  },
  fetchEvents: (sessionId, after) => rpc.request.getLiveSessionEvents({ sessionId, after }),
};
