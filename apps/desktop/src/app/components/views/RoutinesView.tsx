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
  const [run, setRun] = useState<{ id: string; routine: { id: string; title: string } } | null>(null);
  // The routine whose details were open, so Back lands on them again.
  const [returnTo, setReturnTo] = useState<string | undefined>(undefined);

  if (run) {
    return (
      <div className="routines-view routines-view--run">
        <SessionView
          api={liveSessionsApi}
          sessionId={run.id}
          shareBaseUrl={webAppUrl}
          back={
            <button type="button" className="ui-link" onClick={() => { setReturnTo(run.routine.id); setRun(null); }}>
              Back to {run.routine.title}
            </button>
          }
        />
      </div>
    );
  }
  return (
    <div className="routines-view ui-routines-page">
      <RoutinesPanel
        workspaceId={workspaceKey}
        onReconnect={onReconnect}
        initialOpenId={returnTo}
        onOpenRun={(id, routine) => setRun({ id, routine })}
        renderAgentSetup={(harness, status, refresh) =>
          harness === "codex" ? <RoutineCodexSetup status={status} refresh={refresh} />
          : harness === "claude" ? <RoutineClaudeSetup status={status} refresh={refresh} />
          : null}
      />
    </div>
  );
}
