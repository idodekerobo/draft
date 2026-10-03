"use client";

import { useRouter } from "next/navigation";
import { ActivityList, DataBoundary, useRuns } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

function ActivityRuns() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const { data: runs } = useRuns(workspaceId);
  return <ActivityList runs={runs} onFixInConnections={() => router.push("/connections")} />;
}

export default function ActivityPage() {
  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Activity</h1>
      <p className="ui-page__intro">How your workspace context changes over time.</p>
      <DataBoundary fallback={<p className="ui-muted" role="status">Loading activity…</p>}>
        <ActivityRuns />
      </DataBoundary>
    </div>
  );
}
