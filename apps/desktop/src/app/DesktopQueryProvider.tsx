import { DraftQueryProvider, useQueryClient, type DraftApi } from "draft-shared-ui";
import { useEffect, type ReactNode } from "react";
import { useUserIdentity } from "./identity/UserIdentityContext";
import { events, rpc } from "./rpc";

const api: DraftApi = { getRuns: () => rpc.request.getWorkspaceRuns() };

/** Query keys use the cloud workspace id; signed-out state shares one bucket. */
export function useWorkspaceKey(): string {
  return useUserIdentity().workspaceId ?? "signed-out";
}

function InvalidateOnProfileChange() {
  const queryClient = useQueryClient();
  useEffect(() => events.on("profileChanged", () => void queryClient.invalidateQueries()), [queryClient]);
  return null;
}

export function DesktopQueryProvider({ children }: { children: ReactNode }) {
  return (
    <DraftQueryProvider api={api}>
      <InvalidateOnProfileChange />
      {children}
    </DraftQueryProvider>
  );
}
