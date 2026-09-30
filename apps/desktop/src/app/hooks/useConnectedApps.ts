import { useQuery, useRefreshQuery, useSuspenseQuery } from "draft-shared-ui";
import { useWorkspaceKey } from "../DesktopQueryProvider";
import { connectedAppsQueryOptions } from "../queries";

/** Non-suspending: for flows that render their own loading state. */
export function useConnectedApps() {
  const workspaceKey = useWorkspaceKey();
  const { data, isError } = useQuery(connectedAppsQueryOptions(workspaceKey));
  const refresh = useRefreshQuery(connectedAppsQueryOptions(workspaceKey).queryKey);
  return { apps: data ?? null, failed: isError && !data, refresh };
}

/** Suspends until loaded. Wrap the caller in a DataBoundary. */
export function useConnectedAppsSuspense() {
  const workspaceKey = useWorkspaceKey();
  const { data } = useSuspenseQuery(connectedAppsQueryOptions(workspaceKey));
  return { apps: data, refresh: useRefreshQuery(connectedAppsQueryOptions(workspaceKey).queryKey) };
}
