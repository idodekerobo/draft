"use client";

import { DataBoundary } from "../query/DataBoundary";
import { useRuns } from "../query/hooks";
import { ActivityList } from "./ActivityList";

function ActivityRuns({ workspaceId, onFixInConnections, onOpenRun }: { workspaceId: string; onFixInConnections: () => void; onOpenRun?: (sessionId: string) => void }) {
  const { data: runs } = useRuns(workspaceId);
  return <ActivityList runs={runs} onFixInConnections={onFixInConnections} onOpenRun={onOpenRun} />;
}

export function ActivityPanel({ workspaceId, onFixInConnections, onOpenRun }: { workspaceId: string; onFixInConnections: () => void; onOpenRun?: (sessionId: string) => void }) {
  return (
    <>
      <h1 className="ui-page__title">Activity</h1>
      <p className="ui-page__intro">What your workspace agents have been doing.</p>
      <DataBoundary fallback={<p className="ui-muted" role="status">Loading activity…</p>} errorMessage="Could not load activity.">
        <ActivityRuns workspaceId={workspaceId} onFixInConnections={onFixInConnections} onOpenRun={onOpenRun} />
      </DataBoundary>
    </>
  );
}
