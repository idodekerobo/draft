"use client";

import { useCallback } from "react";
import type { LiveSessionInput, LiveSessionsApi } from "./types";

export interface SessionInputsState {
  inputs: LiveSessionInput[];
  send(text: string): Promise<void>;
  act(inputId: string, action: "resend" | "dismiss"): Promise<void>;
}

/** Sends and resends messages. The list of waiting messages comes with the stream poll. */
export function useSessionInputs(api: LiveSessionsApi, sessionId: string, inputs: LiveSessionInput[], refresh: () => Promise<void>): SessionInputsState {
  const send = useCallback(
    async (text: string) => {
      await api.sendMessage(sessionId, text);
      await refresh();
    },
    [api, sessionId, refresh],
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
