"use client";

import { DataBoundary } from "../query/DataBoundary";
import { useRuns } from "../query/hooks";
import { ActivityList } from "./ActivityList";

function ActivityRuns({ workspaceId, onFixInConnections }: { workspaceId: string; onFixInConnections: () => void }) {
  const { data: runs } = useRuns(workspaceId);
  return <ActivityList runs={runs} onFixInConnections={onFixInConnections} />;
}

export function ActivityPanel({ workspaceId, onFixInConnections }: { workspaceId: string; onFixInConnections: () => void }) {
  return (
    <>
      <h1 className="ui-page__title">Activity</h1>
      <p className="ui-page__intro">How your workspace context changes over time.</p>
      <DataBoundary fallback={<p className="ui-muted" role="status">Loading activity…</p>} errorMessage="Could not load activity.">
        <ActivityRuns workspaceId={workspaceId} onFixInConnections={onFixInConnections} />
      </DataBoundary>
    </>
  );
}
