"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_POLL_MS } from "./useSessionStream";
import type { LiveSessionInput, LiveSessionsApi } from "./types";

export interface SessionInputsState {
  inputs: LiveSessionInput[];
  send(text: string): Promise<void>;
  act(inputId: string, action: "resend" | "dismiss"): Promise<void>;
}

/** Messages that are still on their way into the session. Polls like the stream does. */
export function useSessionInputs(api: LiveSessionsApi, sessionId: string): SessionInputsState {
  const [inputs, setInputs] = useState<LiveSessionInput[]>([]);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.listInputs(sessionId);
      if (!cancelled.current) setInputs(next);
    } catch {
      // The stream hook shows load errors; a missed poll heals on the next one.
    }
  }, [api, sessionId]);

  useEffect(() => {
    cancelled.current = false;
    setInputs([]);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, SESSION_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled.current = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

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
