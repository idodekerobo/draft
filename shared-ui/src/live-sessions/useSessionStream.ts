"use client";

import { EVENTS_PAGE_SIZE } from "draft-core/live-sessions";
import { useSuspenseQuery } from "../query";
import { mergeEvents } from "./merge-events";
import { syncSessionIntoLists } from "./sessions-list";
import type { LiveSession, LiveSessionEvent, LiveSessionEventsPage, LiveSessionInput, LiveSessionViewer, LiveSessionsApi } from "./types";

export const SESSION_POLL_MS = 2_000;

export interface SessionStreamData {
  session: LiveSession;
  viewer: LiveSessionViewer;
  events: LiveSessionEvent[];
  inputs: LiveSessionInput[];
}

export interface SessionStreamState extends SessionStreamData {
  /** Fetches now, for after the user's own action. */
  refresh(): Promise<void>;
}

export const sessionStreamKey = (sessionId: string) => ["live-session", sessionId] as const;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Reads a session and keeps it fresh. Each poll asks for events above the last seq in the cache and
 * appends them, and a full page is followed at once by the next one. A poll that finds nothing new
 * returns the cached object, so nothing re-renders. Suspends only until the first page arrives.
 */
export function useSessionStream(api: LiveSessionsApi, sessionId: string): SessionStreamState {
  const key = sessionStreamKey(sessionId);
  const { data, refetch } = useSuspenseQuery({
    queryKey: key,
    queryFn: async ({ client }): Promise<SessionStreamData> => {
      const previous = client.getQueryData<SessionStreamData>(key);
      let events = previous?.events ?? [];
      let page: LiveSessionEventsPage;
      let grew = false;
      do {
        page = await api.fetchEvents(sessionId, events.at(-1)?.seq ?? 0);
        const merged = mergeEvents(events, page.events);
        grew ||= merged !== events;
        events = merged;
      } while (page.events.length >= EVENTS_PAGE_SIZE);

      syncSessionIntoLists(client, page.session);
      if (previous && !grew && sameJson(previous.session, page.session) && sameJson(previous.inputs, page.inputs) && sameJson(previous.viewer, page.viewer)) return previous;
      return { session: page.session, viewer: page.viewer, events, inputs: page.inputs };
    },
    structuralSharing: false,
    staleTime: 0,
    refetchInterval: SESSION_POLL_MS,
  });
  return { ...data, refresh: async () => void (await refetch()) };
}
