import { useMemo, useState } from "react";
import { BackButton, HomeView, SessionView } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { rpc } from "../../rpc";
import { useWebAppUrl } from "../../hooks/useWebAppUrl";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

/** Desktop's Home. A routine run or question opens in place; an approval opens the Sessions list. */
export function HomeScreen({ onOpenSessions, onOpenConnections, onOpenRoutines }: { onOpenSessions: () => void; onOpenConnections: () => void; onOpenRoutines: () => void }) {
  const workspaceId = useWorkspaceKey();
  const webAppUrl = useWebAppUrl();
  const [run, setRun] = useState<string | null>(null);
  const thread = useMemo(() => ({ api: liveSessionsApi, home: { loadSession: () => rpc.request.getHomeSession(), loadModels: () => rpc.request.getHomeModels() } }), []);
  if (run) return <SessionView api={liveSessionsApi} sessionId={run} shareBaseUrl={webAppUrl} back={<BackButton onClick={() => setRun(null)} />} />;
  return (
    <div className="activity">
      <div className="ui-page">
        <HomeView workspaceId={workspaceId} thread={thread} onOpenSession={onOpenSessions} onOpenRun={setRun} onOpenConnections={onOpenConnections} onOpenRoutines={onOpenRoutines} />
      </div>
    </div>
  );
}
