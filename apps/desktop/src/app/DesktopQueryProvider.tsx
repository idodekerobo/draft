import { DraftQueryProvider, SessionViewStateProvider, toRoutineError, useWorkspaceDataSignals, type DraftApi } from "draft-shared-ui";
import { type ReactNode } from "react";
import { useUserIdentity } from "./identity/UserIdentityContext";
import { watchSignals } from "./liveSessionsApi";
import { useAnalytics } from "./analytics/AnalyticsContext";
import { rpc } from "./rpc";

const api: DraftApi = {
  getRuns: (before) => rpc.request.getWorkspaceRuns(before ? { before } : undefined),
  getNeedsYou: () => rpc.request.getNeedsYou(),
  actOnNotification: (id, action) => rpc.request.actOnNotification({ id, action }),
  getRoutines: () => rpc.request.listRoutines(),
  getRunDetail: (runId) => rpc.request.getRunDetail({ runId }),
  getRunTranscript: (runId) => rpc.request.getRunTranscript({ runId }),
  updateRoutine: async (id, patch) => {
    const result = await rpc.request.updateRoutine({ id, patch });
    if (!result.ok) throw toRoutineError(result.code, result.field);
    return result.routine;
  },
  createRoutine: async (input) => {
    const result = await rpc.request.createRoutine(input);
    if (!result.ok) throw toRoutineError(result.code, result.field);
    return result.routine;
  },
  deleteRoutine: async (id) => {
    const result = await rpc.request.deleteRoutine({ id });
    if (!result.ok) throw new Error(result.message ?? toRoutineError(result.code, result.field).message);
  },
  runRoutine: async (id) => {
    const result = await rpc.request.runRoutine({ id });
    if (!result.ok) throw new Error(result.message ?? toRoutineError(result.code, result.field).message);
    return result.outcome;
  },
  getRoutineSlackChannels: () => rpc.request.getRoutineSlackChannels(),
  getRoutineGithubRepos: () => rpc.request.getRoutineGithubRepos(),
  getRoutineRuns: (id, before) => rpc.request.listRoutineRuns(before ? { id, before } : { id }),
};

/** Query keys use the cloud workspace id; signed-out state shares one bucket. */
export function useWorkspaceKey(): string {
  return useUserIdentity().workspaceId ?? "signed-out";
}

function WorkspaceDataSignals() {
  const workspaceKey = useWorkspaceKey();
  useWorkspaceDataSignals(watchSignals, workspaceKey === "signed-out" ? null : workspaceKey);
  return null;
}

export function DesktopQueryProvider({ children }: { children: ReactNode }) {
  const identity = useUserIdentity();
  const { track } = useAnalytics();
  const scope = `${identity.signedIn}:${identity.workspaceId ?? ""}`;
  return (
    <DraftQueryProvider api={api} track={track}>
      <SessionViewStateProvider scope={scope}>
        <WorkspaceDataSignals />
        {children}
      </SessionViewStateProvider>
    </DraftQueryProvider>
  );
}
