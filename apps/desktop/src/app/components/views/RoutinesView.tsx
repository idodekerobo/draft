// RoutinesView.tsx — recurring routines and their schedules, and the runs of agent routines

import { useState } from "react";
import { RoutinesPanel, SessionView } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { RoutineClaudeSetup, RoutineCodexSetup } from "../connections/RoutineAgentSetup";
import { useWebAppUrl } from "../../hooks/useWebAppUrl";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function RoutinesView({ onReconnect }: { onReconnect: () => void }) {
  const workspaceKey = useWorkspaceKey();
  const webAppUrl = useWebAppUrl();
  const [runId, setRunId] = useState<string | null>(null);

  if (runId) {
    return (
      <div className="routines-view routines-view--run">
        <SessionView
          api={liveSessionsApi}
          sessionId={runId}
          shareBaseUrl={webAppUrl}
          back={<button type="button" className="ui-link" onClick={() => setRunId(null)}>Routines</button>}
        />
      </div>
    );
  }
  return (
    <div className="routines-view ui-routines-page">
      <RoutinesPanel
        workspaceId={workspaceKey}
        onReconnect={onReconnect}
        onOpenRun={setRunId}
        renderAgentSetup={(harness, status, refresh) =>
          harness === "codex" ? <RoutineCodexSetup status={status} refresh={refresh} />
          : harness === "claude" ? <RoutineClaudeSetup status={status} refresh={refresh} />
          : null}
      />
    </div>
  );
}
