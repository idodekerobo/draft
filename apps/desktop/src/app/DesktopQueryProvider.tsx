import { DraftQueryProvider, type DraftApi } from "draft-shared-ui";
import { type ReactNode } from "react";
import { useUserIdentity } from "./identity/UserIdentityContext";
import { rpc } from "./rpc";

const api: DraftApi = { getRuns: () => rpc.request.getWorkspaceRuns() };

/** Query keys use the cloud workspace id; signed-out state shares one bucket. */
export function useWorkspaceKey(): string {
  return useUserIdentity().workspaceId ?? "signed-out";
}

export function DesktopQueryProvider({ children }: { children: ReactNode }) {
  return (
    <DraftQueryProvider api={api}>
      {children}
    </DraftQueryProvider>
  );
}
