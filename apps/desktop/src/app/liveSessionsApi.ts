import { liveTextListener, toApprovalResult, type LiveSessionsApi } from "draft-shared-ui";
import { liveTextTopic } from "draft-core/live-sessions";
import { rpc, events } from "./rpc";
import { createWindowSignalWatcher } from "./signalWatcher";

const PRESENCE_POLL_MS = 5_000;
const PRESENCE_FIRST_FOLLOW_UP_MS = 1_500;

const signals = createWindowSignalWatcher({
  setTopics: (topics) => rpc.request.setSignalTopics({ topics }),
  onSignal: (handler) => events.on("liveSignal", ({ topic, event, payload }) => handler(topic, event, payload)),
  onConnection: (handler) => events.on("liveConnection", ({ connected }) => handler(connected)),
});
export const watchSignals = signals.watch;

export const liveSessionsApi: LiveSessionsApi = {
  watchSignals,
  watchLiveText: (sessionId, onChunk) => watchSignals(liveTextTopic(sessionId), liveTextListener(onChunk)),
  watchConnection: signals.watchConnection,
  listSessions: () => rpc.request.listLiveSessions(),
  fetchEvents: (sessionId, after) => rpc.request.getLiveSessionEvents({ sessionId, after }),
  sendMessage: async (sessionId, text) => {
    const result = await rpc.request.sendLiveSessionMessage({ sessionId, text });
    if (!result.ok) throw new Error(result.error);
    return result.input ? { ...result.input, mine: true } : undefined;
  },
  actOnInput: (sessionId, inputId, action) => rpc.request.actOnLiveSessionInput({ sessionId, inputId, action }),
  decideApproval: async (sessionId, requestId, response) => {
    const result = await rpc.request.decideLiveSessionApproval({ sessionId, requestId, ...response });
    return result.ok ? { ok: true } : toApprovalResult(result.error, result.byName);
  },
  setMode: async (sessionId, change) => {
    const result = await rpc.request.setLiveSessionMode({ sessionId, ...change });
    if (!result.ok) throw new Error(result.error);
  },
  stop: async (sessionId, options) => {
    const result = await rpc.request.stopLiveSession({ sessionId, keepQueued: options?.keepQueued });
    if (!result.ok) throw new Error(result.error);
    return { withdrawn: result.withdrawn };
  },
  resume: async (sessionId) => {
    const result = await rpc.request.resumeLiveSession({ sessionId });
    if (!result.ok) throw new Error(result.error);
  },
  watchPresence: (sessionId, viewer, onChange) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // The first answer is empty while the channel joins, so the second ask comes sooner.
    const ask = (delay: number, next: number) => {
      timer = setTimeout(async () => {
        try {
          const { names } = await rpc.request.pollLiveSessionPresence({ sessionId, viewerId: viewer.id, viewerName: viewer.name });
          if (!stopped) onChange(names);
        } catch {
          // The next ask tries again.
        }
        if (!stopped) ask(next, PRESENCE_POLL_MS);
      }, delay);
    };
    ask(0, PRESENCE_FIRST_FOLLOW_UP_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  },
};
