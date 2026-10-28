"use client";

import { useCallback } from "react";
import { useQueryClient } from "../query";
import { syncSessionIntoLists } from "./sessions-list";
import { sessionStreamKey, type SessionStreamData } from "./useSessionStream";
import type { LiveSessionInput, LiveSessionsApi } from "./types";

export interface SessionInputsState {
  inputs: LiveSessionInput[];
  send(text: string): Promise<void>;
  act(inputId: string, action: "resend" | "dismiss"): Promise<void>;
}

/**
 * Sends and resends messages. The list of waiting messages comes with the stream poll.
 * A sent message moves the session to the top of the sidebar at once; the next stream poll replaces that guess with the server's time.
 */
export function useSessionInputs(api: LiveSessionsApi, sessionId: string, inputs: LiveSessionInput[], refresh: () => Promise<void>): SessionInputsState {
  const client = useQueryClient();
  const send = useCallback(
    async (text: string) => {
      const session = client.getQueryData<SessionStreamData>(sessionStreamKey(sessionId))?.session;
      if (session) syncSessionIntoLists(client, { ...session, last_event_at: new Date().toISOString() });
      await api.sendMessage(sessionId, text);
      await refresh();
    },
    [api, client, sessionId, refresh],
  );

  const act = useCallback(
    async (inputId: string, action: "resend" | "dismiss") => {
      await api.actOnInput(sessionId, inputId, action);
      await refresh();
    },
    [api, sessionId, refresh],
  );

  return { inputs, send, act };
}
