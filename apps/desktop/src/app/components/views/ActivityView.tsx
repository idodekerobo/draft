import { useState } from "react";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWebAppUrl } from "../../hooks/useWebAppUrl";
import { ActivityPanel, BackButton, SessionView } from "draft-shared-ui";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function ActivityView({ onFixInConnections, onOpenRoutine }: { onFixInConnections: () => void; onOpenRoutine: (id: string) => void }) {
  const workspaceId = useWorkspaceKey();
  const webAppUrl = useWebAppUrl();
  const [run, setRun] = useState<string | null>(null);
  if (run) return <SessionView api={liveSessionsApi} sessionId={run} shareBaseUrl={webAppUrl} back={<BackButton onClick={() => setRun(null)} />} />;
  return (
    <div className="activity">
      <div className="ui-page">
        <ActivityPanel workspaceId={workspaceId} onFixInConnections={onFixInConnections} onOpenRoutine={onOpenRoutine} onOpenRun={setRun} />
      </div>
    </div>
  );
}
