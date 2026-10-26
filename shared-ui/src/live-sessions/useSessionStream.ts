"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeEvents } from "./merge-events";
import { LiveSessionsDisabledError, type LiveSession, type LiveSessionEvent, type LiveSessionsApi } from "./types";

export const SESSION_POLL_MS = 2_000;

export interface SessionStreamState {
  session: LiveSession | null;
  events: LiveSessionEvent[];
  error: Error | null;
}

/** Polls for events above the last seq while the page is visible, and at once on focus. */
export function useSessionStream(api: LiveSessionsApi, sessionId: string): SessionStreamState {
  const [state, setState] = useState<SessionStreamState>({ session: null, events: [], error: null });
  const lastSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const cancelled = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current || cancelled.current) return;
    inFlight.current = true;
    try {
      const page = await api.fetchEvents(sessionId, lastSeq.current);
      if (cancelled.current) return;
      lastSeq.current = Math.max(lastSeq.current, page.events.at(-1)?.seq ?? 0);
      setState((prev) => ({ session: page.session, events: mergeEvents(prev.events, page.events), error: null }));
    } catch (error) {
      if (!cancelled.current) setState((prev) => ({ ...prev, error: error instanceof Error ? error : new Error(String(error)) }));
      if (error instanceof LiveSessionsDisabledError) cancelled.current = true;
    } finally {
      inFlight.current = false;
    }
  }, [api, sessionId]);

  useEffect(() => {
    cancelled.current = false;
    lastSeq.current = 0;
    setState({ session: null, events: [], error: null });

    const schedule = () => {
      timer.current = setTimeout(async () => {
        if (!document.hidden) await poll();
        if (!cancelled.current) schedule();
      }, SESSION_POLL_MS);
    };
    const refetchNow = () => {
      if (!document.hidden) void poll();
    };

    void poll();
    schedule();
    window.addEventListener("focus", refetchNow);
    document.addEventListener("visibilitychange", refetchNow);
    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("focus", refetchNow);
      document.removeEventListener("visibilitychange", refetchNow);
    };
  }, [poll]);

  return state;
}
