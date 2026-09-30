import { useCallback } from "react";
import { queryKeys, useQuery, useQueryClient } from "draft-shared-ui";
import type { ContextFileEntry } from "../../rpc/schema";
import { useWorkspaceKey } from "../DesktopQueryProvider";
import { useUserIdentity } from "../identity/UserIdentityContext";
import { contextFilesQueryOptions } from "../queries";

type FilesUpdate = ContextFileEntry[] | ((current: ContextFileEntry[]) => ContextFileEntry[]);

/**
 * The signed-in workspace's context documents. Keyed by workspace, so a switch
 * never shows the previous workspace's files while the new ones load.
 */
export function useContextFiles() {
  const { workspaceId, signedIn } = useUserIdentity();
  const workspaceKey = useWorkspaceKey();
  const enabled = Boolean(workspaceId && signedIn);
  const queryClient = useQueryClient();
  const query = useQuery(contextFilesQueryOptions(workspaceKey, enabled));

  const setFiles = useCallback((update: FilesUpdate) => {
    queryClient.setQueryData<ContextFileEntry[]>(queryKeys.context(workspaceKey), (current) =>
      typeof update === "function" ? update(current ?? []) : update,
    );
  }, [queryClient, workspaceKey]);

  const reloadFiles = useCallback(async () => {
    if (!enabled) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.context(workspaceKey) });
  }, [enabled, queryClient, workspaceKey]);

  const loading = enabled && query.isPending;
  return {
    files: query.data ?? [],
    loading,
    // A failed fetch settles with no files, as the previous loader did.
    settled: enabled && !query.isPending,
    setFiles,
    reloadFiles,
  };
}
