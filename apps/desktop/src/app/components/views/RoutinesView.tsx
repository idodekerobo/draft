// RoutinesView.tsx — recurring routines and their schedules, and the runs of agent routines

import { useState } from "react";
import { RoutinesPanel, SessionView } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function RoutinesView({ onReconnect }: { onReconnect: () => void }) {
  const workspaceKey = useWorkspaceKey();
  const [runId, setRunId] = useState<string | null>(null);

  if (runId) {
    return (
      <div className="routines-view routines-view--run">
        <SessionView
          api={liveSessionsApi}
          sessionId={runId}
          back={<button type="button" className="ui-link" onClick={() => setRunId(null)}>Routines</button>}
        />
      </div>
    );
  }
  return (
    <div className="routines-view ui-routines-page">
      <RoutinesPanel workspaceId={workspaceKey} onReconnect={onReconnect} onOpenRun={setRunId} />
    </div>
  );
}
