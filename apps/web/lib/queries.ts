import { queryKeys, queryOptions, STALE_MS, type TeamSessionRepo } from "draft-shared-ui";
import { ApiError } from "@/lib/api-error";

/** Browser code passes apiFetch; server layouts pass a token-based fetcher. */
export type Fetcher = <T>(path: string) => Promise<T>;

export interface ContextSnapshot {
  versionNumber: number;
  createdAt: string;
  documents: Record<string, { content: string }>;
}

export interface ConnectionsBody {
  connections: unknown[];
  agent?: { last_used_at: string | null };
}

/** null means the workspace has no context yet. */
export const contextQueryOptions = (workspaceId: string, fetcher: Fetcher) =>
  queryOptions({
    queryKey: queryKeys.context(workspaceId),
    queryFn: async (): Promise<ContextSnapshot | null> => {
      try {
        return await fetcher<ContextSnapshot>(`/workspaces/${workspaceId}/context`);
      } catch (error) {
        if (error instanceof ApiError && error.code === "no_context_yet") return null;
        throw error;
      }
    },
    staleTime: STALE_MS.context,
  });

export const connectionsQueryOptions = (workspaceId: string, fetcher: Fetcher) =>
  queryOptions({
    queryKey: queryKeys.connections(workspaceId),
    queryFn: () => fetcher<ConnectionsBody>(`/workspaces/${workspaceId}/connections`),
    staleTime: STALE_MS.connections,
  });

export const sessionReposQueryOptions = (workspaceId: string, fetcher: Fetcher) =>
  queryOptions({
    queryKey: queryKeys.sessionRepos(workspaceId),
    queryFn: async () => (await fetcher<{ projects: TeamSessionRepo[] }>(`/workspaces/${workspaceId}/sessions/projects`)).projects,
    staleTime: STALE_MS.connections,
  });
