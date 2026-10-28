"use client";

import type { QueryClient } from "@tanstack/react-query";
import { splitAuthor } from "draft-core/live-sessions";
import { useQuery } from "../query";
import { POLL_MS } from "../query/options";
import { LiveSessionsDisabledError, type LiveSession, type LiveSessionsApi } from "./types";

export const liveSessionsQueryKey = (workspaceId: string) => ["ws", workspaceId, "live-sessions"] as const;

type SessionsListData = { enabled: boolean; sessions: LiveSession[] };

const activityMs = (session: Pick<LiveSession, "last_event_at">) => (session.last_event_at ? Date.parse(session.last_event_at) : -Infinity);

/** Copies a session row with newer activity into every cached sessions list, so the sidebar does not wait for its own poll. An older row never wins; `force` is for undoing a guess. */
export function syncSessionIntoLists(client: QueryClient, session: LiveSession, force = false) {
  client.setQueriesData<SessionsListData>(
    { queryKey: ["ws"], predicate: (query) => query.queryKey[2] === "live-sessions" },
    (data) => {
      const current = data?.sessions.find((s) => s.id === session.id);
      if (!data || !current || current.last_event_at === session.last_event_at) return data;
      if (!force && activityMs(session) < activityMs(current)) return data;
      return { ...data, sessions: data.sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s)) };
    },
  );
}

/** A fresh list from the server keeps the newer activity time of a row that a local send already moved up. */
export function keepNewerActivity(previous: SessionsListData | undefined, fresh: SessionsListData): SessionsListData {
  if (!previous) return fresh;
  const before = new Map(previous.sessions.map((s) => [s.id, s]));
  return {
    ...fresh,
    sessions: fresh.sessions.map((s) => {
      const old = before.get(s.id);
      return old && activityMs(old) > activityMs(s) ? { ...s, last_event_at: old.last_event_at } : s;
    }),
  };
}

/** `enabled` is false when the workspace has the feature off; callers hide the Sessions entry then. */
export function useLiveSessions(api: LiveSessionsApi, workspaceId: string) {
  const query = useQuery({
    queryKey: liveSessionsQueryKey(workspaceId),
    queryFn: async ({ client }) => {
      try {
        const fresh = { enabled: true, sessions: await api.listSessions() };
        return keepNewerActivity(client.getQueryData<SessionsListData>(liveSessionsQueryKey(workspaceId)), fresh);
      } catch (error) {
        if (error instanceof LiveSessionsDisabledError) return { enabled: false, sessions: [] as LiveSession[] };
        throw error;
      }
    },
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
  return { ...query, enabled: query.data?.enabled ?? false, sessions: query.data?.sessions ?? [] };
}

export function sessionTitle(session: Pick<LiveSession, "title" | "folder_name">): string {
  const title = session.title ? splitAuthor(session.title).text.trim() : null;
  return title || `New session in ${session.folder_name ?? "a folder"}`;
}
