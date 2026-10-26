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

export function sessionTitle(session: Pick<LiveSession, "title" | "folder_name">): string {
  return session.title ?? `New session in ${session.folder_name ?? "a folder"}`;
}

export function SessionsList({
  sessions,
  onOpen,
}: {
  sessions: LiveSession[];
  onOpen: (sessionId: string) => void;
}) {
  if (sessions.length === 0) return <p className="ui-muted" role="status">No sessions yet.</p>;
  return (
    <ul className="ui-sessions-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <button type="button" className="ui-sessions-list__row" onClick={() => onOpen(session.id)}>
            <span className="ui-sessions-list__title">{sessionTitle(session)}</span>
            <span className="ui-muted">{session.owner_name ?? "Someone"} · {session.status.replace("_", " ")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
