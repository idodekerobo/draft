"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addChunk, emptyLiveText, reconcile, type LivePreview, type LiveTextState } from "./live-text";
import type { LiveSessionEvent, LiveSessionsApi } from "./types";

/** Expired previews are dropped on this beat, since no chunk or stored event may arrive to do it. */
const SWEEP_MS = 5_000;

/** The text the agent is writing now, until the stored message replaces it. */
export function useLiveText(api: LiveSessionsApi, sessionId: string, events: LiveSessionEvent[]): LivePreview[] {
  const [state, setState] = useState<LiveTextState>(emptyLiveText);
  const lastSeq = useRef(0);
  const latestEvents = useRef(events);
  lastSeq.current = events.at(-1)?.seq ?? 0;
  latestEvents.current = events;

  useEffect(() => {
    setState(emptyLiveText);
    if (!api.watchLiveText) return;
    return api.watchLiveText(sessionId, (chunk) => setState((s) => addChunk(s, chunk, lastSeq.current, Date.now())));
  }, [api, sessionId]);

  useEffect(() => {
    setState((s) => reconcile(s, events, Date.now()));
  }, [events]);

  const hasPreviews = state.previews.length > 0;
  useEffect(() => {
    if (!hasPreviews) return;
    const timer = setInterval(() => setState((s) => reconcile(s, latestEvents.current, Date.now())), SWEEP_MS);
    return () => clearInterval(timer);
  }, [hasPreviews]);

  return useMemo(() => state.previews.filter((p) => p.text !== ""), [state.previews]);
}
