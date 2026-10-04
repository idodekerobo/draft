import { requestApi } from "@/lib/api-request";
import { connectionsQueryOptions, contextQueryOptions, sessionReposQueryOptions, type Fetcher } from "@/lib/queries";
import type { QueryClient } from "draft-shared-ui";

const serverFetcher = (token: string): Fetcher => <T,>(path: string) => requestApi<T>(path, token, { cache: "no-store" });

/** Failures are not dehydrated, so the browser simply fetches them itself. */
export async function prefetchWorkspace(queryClient: QueryClient, workspaceId: string, token: string): Promise<void> {
  const fetcher = serverFetcher(token);
  await Promise.all([
    queryClient.prefetchQuery(contextQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(connectionsQueryOptions(workspaceId, fetcher)),
    queryClient.prefetchQuery(sessionReposQueryOptions(workspaceId, fetcher)),
  ]);
}
