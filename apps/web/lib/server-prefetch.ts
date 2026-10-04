import { requestApi } from "@/lib/api-request";
import { connectionsQueryOptions, contextQueryOptions, sessionReposQueryOptions, type Fetcher } from "@/lib/queries";
import { routinesQueryOptions, type DraftApi, type QueryClient, type RoutinesResponse } from "draft-shared-ui";

const serverFetcher = (token: string): Fetcher => <T,>(path: string) => requestApi<T>(path, token, { cache: "no-store" });

/** Failures are not dehydrated, so the browser simply fetches them itself. */
export async function prefetchWorkspace(queryClient: QueryClient, workspaceId: string, token: string): Promise<void> {
  const fetcher = serverFetcher(token);
  // Only the routines read is needed here, so the rest of the browser API is left out.
  const routinesApi = { getRoutines: () => fetcher<RoutinesResponse>(`/workspaces/${workspaceId}/schedules`) } as DraftApi;
  await Promise.all([
    queryClient.prefetchQuery(contextQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(connectionsQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(sessionReposQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(routinesQueryOptions(routinesApi, workspaceId)),
  ]);
}
