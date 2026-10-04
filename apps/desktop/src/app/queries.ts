import { POLL_MS, STALE_MS, queryKeys, queryOptions } from "draft-shared-ui";
import { rpc } from "./rpc";

const EMPTY_CONTEXT_POLL_MS = 60_000;

export const connectedAppsQueryOptions = (workspaceKey: string) =>
  queryOptions({
    queryKey: queryKeys.connectedApps(workspaceKey),
    queryFn: () => rpc.request.getConnectedApps(),
    staleTime: STALE_MS.connections,
    refetchInterval: POLL_MS,
  });

/** Poll every minute while the workspace has no documents yet. */
export const contextFilesQueryOptions = (workspaceKey: string, enabled: boolean) =>
  queryOptions({
    queryKey: queryKeys.context(workspaceKey),
    queryFn: () => rpc.request.getContextFiles(),
    enabled,
    staleTime: STALE_MS.context,
    refetchInterval: (query) => (query.state.data?.length === 0 ? EMPTY_CONTEXT_POLL_MS : false),
  });

export const localConfigQueryOptions = queryOptions({
  queryKey: ["app", "local-config"] as const,
  queryFn: () => rpc.request.getLocalConfig(),
});

export const appVersionQueryOptions = queryOptions({
  queryKey: ["app", "version"] as const,
  queryFn: () => rpc.request.getAppVersion(),
  staleTime: Infinity,
});

export const crispConfigQueryOptions = queryOptions({
  queryKey: ["app", "crisp-config"] as const,
  queryFn: () => rpc.request.getCrispConfig(),
  staleTime: Infinity,
});
