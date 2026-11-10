import { queryKeys, queryOptions, STALE_MS, type TeamSessionRepo } from "draft-shared-ui";
import { ApiError } from "@/lib/api-error";
import { callTool, type Fetcher } from "@/lib/tools";

export type { Fetcher };

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
        const read = await callTool<{ versionNumber: number; createdAt: string; documents: Array<{ path: string; content: string }> }>(fetcher, workspaceId, "context.read");
        return {
          versionNumber: read.versionNumber,
          createdAt: read.createdAt,
          documents: Object.fromEntries(read.documents.map((document) => [document.path, { content: document.content }])),
        };
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
