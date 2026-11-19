"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionSignalTopic } from "draft-core/live-sessions";
import { useQueryClient, useSuspenseQuery } from "../query";
import { mergeEvents, patchAuthors } from "./merge-events";
import { mergeTranscriptPage, transcriptEvents } from "./transcript-pages";
import { useSessionViewStates } from "./view-state";
import { SESSION_DISCONNECTED_POLL_MS, SESSION_SAFETY_POLL_MS, useSignals } from "./signals";
import { syncSessionIntoLists } from "./sessions-list";
import type { LiveSession, LiveSessionEvent, LiveSessionEventsPage, LiveSessionInput, LiveSessionViewer, LiveSessionsApi, SessionTranscriptPage, SessionAgentSummary } from "./types";

export interface SessionStreamData {
  session: LiveSession;
  viewer: LiveSessionViewer;
  events: LiveSessionEvent[];
  inputs: LiveSessionInput[];
  page?: SessionTranscriptPage;
  agents?: SessionAgentSummary[];
  approvals?: LiveSessionEvent[];
}

export interface SessionStreamState extends SessionStreamData {
  refresh(): Promise<void>;
  cacheKey: readonly string[];
  readThrough: number;
  recentEvents: LiveSessionEvent[];
  history?: {
    hasOlder: boolean;
    loading: boolean;
    error: string | null;
    focused: boolean;
    failedTarget: number | null;
    before: number | null;
    loadOlder(): Promise<boolean>;
    focus(seq: number): Promise<{ agentId: string | null; seq: number } | null>;
    latest(): void;
  };
}

export const sessionStreamKey = (sessionId: string, scope?: string) => scope ? ["live-session", scope, sessionId] as const : ["live-session", sessionId] as const;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const sessionPollMs = (connected: boolean) => connected ? SESSION_SAFETY_POLL_MS : SESSION_DISCONNECTED_POLL_MS;

export function useSessionStream(api: LiveSessionsApi, sessionId: string): SessionStreamState {
  const states = useSessionViewStates();
  const client = useQueryClient();
  const key = useMemo(() => sessionStreamKey(sessionId, api.fetchView ? states.scope : undefined), [sessionId, api.fetchView, states.scope]);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [connected, setConnected] = useState(true);
  const [windowSeq, setWindowSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedTarget, setFailedTarget] = useState<number | null>(null);
  const focusRequest = useRef(0);
  const busy = useRef(false);
  const [windowVersion, setWindowVersion] = useState(0);
  const focusKey = (seq: number) => [...key, "window", String(seq)];
  useEffect(() => api.watchConnection?.(setConnected), [api]);
  const { data, refetch } = useSuspenseQuery({
    queryKey: key,
    queryFn: async ({ client }): Promise<SessionStreamData> => {
      const previous = client.getQueryData<SessionStreamData>(key);
      if (api.fetchView) {
        const response = await api.fetchView(sessionId, previous?.page ? { after: previous.page.readThrough } : {});
        if (!response.snapshot) throw new Error("Session state was missing");
        let page = mergeTranscriptPage(previous?.page, response.page);
        const snapshot = response.snapshot;
        const makeData = (): SessionStreamData => {
          page = { ...page, events: patchAuthors(page.events, snapshot.authors), dependencies: patchAuthors(page.dependencies, snapshot.authors) };
          const events = previous?.page?.events === page.events && previous.page.dependencies === page.dependencies ? previous.events : transcriptEvents(page);
          return { session: snapshot.session, viewer: snapshot.viewer, inputs: snapshot.inputs, events, page, agents: snapshot.agents, approvals: snapshot.approvals };
        };
        syncSessionIntoLists(client, snapshot.session);
        while (page.hasNewer && active.current) {
          client.setQueryData(key, makeData());
          const next = await api.fetchView(sessionId, { after: page.readThrough, through: page.through, state: false });
          if (next.page.readThrough <= page.readThrough && next.page.hasNewer) throw new Error("History cursor did not advance");
          page = mergeTranscriptPage(page, next.page);
        }
        return makeData();
      }
      let events = previous?.events ?? [];
      let page: LiveSessionEventsPage;
      let grew = false;
      do {
        page = await api.fetchEvents(sessionId, events.at(-1)?.seq ?? 0);
        const merged = mergeEvents(events, page.events);
        grew ||= merged !== events;
        events = merged;
      } while (page.events.length > 0 && (events.at(-1)?.seq ?? 0) < page.session.last_seq);
      const patched = patchAuthors(events, page.authors);
      grew ||= patched !== events;
      events = patched;
      syncSessionIntoLists(client, page.session);
      if (previous && !grew && sameJson(previous.session, page.session) && sameJson(previous.inputs, page.inputs) && sameJson(previous.viewer, page.viewer)) return previous;
      return { session: page.session, viewer: page.viewer, events, inputs: page.inputs };
    },
    structuralSharing: false,
    staleTime: 0,
    refetchInterval: sessionPollMs(connected),
  });
  useSignals(api.watchSignals, sessionSignalTopic(sessionId), async () => void (await refetch({ cancelRefetch: false })));
  const focused = windowSeq === null ? undefined : client.getQueryData<SessionTranscriptPage>(focusKey(windowSeq));
  const visible = focused ?? data.page;
  const loadOlder = async () => {
    if (!api.fetchView || !visible?.hasOlder || visible.before === null || busy.current) return false;
    busy.current = true; setLoading(true); setError(null); setFailedTarget(null);
    const capturedSeq = windowSeq;
    try {
      const response = await client.fetchQuery({ queryKey: [...key, "older", String(capturedSeq), String(visible.before)],
        queryFn: () => api.fetchView!(sessionId, { before: visible.before!, through: visible.through, state: false }), staleTime: Infinity });
      if (capturedSeq !== null) {
        client.setQueryData<SessionTranscriptPage>(focusKey(capturedSeq), (current) => mergeTranscriptPage(current ?? visible, response.page, "older"));
        if (active.current) setWindowVersion((v) => v + 1);
      } else {
        client.setQueryData<SessionStreamData>(key, (current) => {
          if (!current) return current;
          const page = mergeTranscriptPage(current.page, response.page, "older");
          return { ...current, page, events: transcriptEvents(page) };
        });
      }
      return true;
    } catch { if (active.current) setError("Could not load older messages."); return false; }
    finally { busy.current = false; if (active.current) setLoading(false); }
  };
  const focus = async (seq: number) => {
    if (!api.fetchView) return null;
    const request = ++focusRequest.current;
    setError(null); setFailedTarget(null); setLoading(true);
    try {
      const response = await client.fetchQuery({ queryKey: [...key, "around", String(seq)],
        queryFn: () => api.fetchView!(sessionId, { around: seq, state: false }), staleTime: 0 });
      if (!active.current || request !== focusRequest.current) return null;
      if (response.page.agentId) {
        client.setQueryData([...key, "agent-window", response.page.agentId, String(seq)], response.page);
        const agent = data.agents?.find((a) => a.agentId === response.page.agentId);
        if (agent?.hostSeq) {
          const root = await client.fetchQuery({ queryKey: [...key, "around-root", String(agent.hostSeq)],
            queryFn: () => api.fetchView!(sessionId, { around: agent.hostSeq!, state: false }), staleTime: 0 });
          client.setQueryData(focusKey(seq), root.page);
          if (active.current && request === focusRequest.current) { setWindowSeq(seq); setWindowVersion((v) => v + 1); }
        }
      } else {
        client.setQueryData(focusKey(seq), response.page);
        setWindowSeq(seq); setWindowVersion((v) => v + 1);
      }
      if (!active.current || request !== focusRequest.current) return null;
      return { agentId: response.page.agentId, seq };
    } catch {
      if (active.current && request === focusRequest.current) { setError("This message is unavailable or could not be loaded."); setFailedTarget(seq); }
      return null;
    } finally { if (active.current && request === focusRequest.current) setLoading(false); }
  };
  const events = useMemo(() => focused ? transcriptEvents(focused) : data.events, [focused, data.events, windowVersion]);
  return { ...data, events, cacheKey: key, recentEvents: data.events, readThrough: data.page?.readThrough ?? data.events.at(-1)?.seq ?? 0,
    refresh: async () => void (await refetch({ cancelRefetch: false })),
    history: api.fetchView ? { before: visible?.before ?? null, hasOlder: visible?.hasOlder ?? false, loading, error, failedTarget, focused: windowSeq !== null, loadOlder, focus, latest: () => { focusRequest.current++; setWindowSeq(null); setError(null); setFailedTarget(null); setLoading(false); } } : undefined };
}
