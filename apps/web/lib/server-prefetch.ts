import { requestApi } from "@/lib/api-request";
import { connectionsQueryOptions, contextQueryOptions, sessionReposQueryOptions, type Fetcher } from "@/lib/queries";
import { routinesQueryOptions, type QueryClient, type RoutinesResponse } from "draft-shared-ui";

// This runs on the Next.js server, so it sends no Origin. The header tells the backend it is the app, not an agent.
// It is only set here: a browser request carrying it would need a CORS preflight the API does not allow.
export const serverFetcher = (token: string): Fetcher => <T,>(path: string) =>
  requestApi<T>(path, token, { cache: "no-store", headers: { "x-draft-client": "web" } });

/** Failures are not dehydrated, so the browser simply fetches them itself. */
export async function prefetchWorkspace(queryClient: QueryClient, workspaceId: string, token: string): Promise<void> {
  const fetcher = serverFetcher(token);
  const routinesApi = { getRoutines: () => fetcher<RoutinesResponse>(`/workspaces/${workspaceId}/schedules`) };
  await Promise.all([
    queryClient.prefetchQuery(contextQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(connectionsQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(sessionReposQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(routinesQueryOptions(routinesApi, workspaceId)),
  ]);
}
