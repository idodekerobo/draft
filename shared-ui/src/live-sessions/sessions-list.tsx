"use client";

import { useQuery } from "../query";
import { POLL_MS } from "../query/options";
import { LiveSessionsDisabledError, type LiveSession, type LiveSessionsApi } from "./types";

export const liveSessionsQueryKey = (workspaceId: string) => ["ws", workspaceId, "live-sessions"] as const;

/** `enabled` is false when the workspace has the feature off; callers hide the Sessions entry then. */
export function useLiveSessions(api: LiveSessionsApi, workspaceId: string) {
  const query = useQuery({
    queryKey: liveSessionsQueryKey(workspaceId),
    queryFn: async () => {
      try {
        return { enabled: true, sessions: await api.listSessions() };
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

const AUTHOR_PREFIX = /^\[[^\]\n]{1,60} via Draft\]\s*/;

export function sessionTitle(session: Pick<LiveSession, "title" | "folder_name">): string {
  const title = session.title?.replace(AUTHOR_PREFIX, "").trim();
  return title || `New session in ${session.folder_name ?? "a folder"}`;
}
