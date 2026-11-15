"use client";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { DataBoundary } from "../query/DataBoundary";
import { useDraftApi } from "../query/api";
import { runHistoryQueryOptions } from "../query/options";
import { ActivityList } from "./ActivityList";

function ActivityRuns({ workspaceId, onFixInConnections, onOpenRun }: { workspaceId: string; onFixInConnections: () => void; onOpenRun?: (sessionId: string) => void }) {
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useSuspenseInfiniteQuery(runHistoryQueryOptions(useDraftApi(), workspaceId));
  // A run that started while older pages were open can shift one onto the next page; show it once.
  const runs = [...new Map(data.pages.flat().map((run) => [run.id, run])).values()];
  return (
    <>
      <ActivityList runs={runs} onFixInConnections={onFixInConnections} onOpenRun={onOpenRun} />
      {hasNextPage && (
        <div className="ui-activity-more">
          <button type="button" className="ui-btn" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? "Loading…" : "Show older runs"}
          </button>
          {isFetchNextPageError && <p className="ui-error" role="alert">Could not load older runs. Try again.</p>}
        </div>
      )}
    </>
  );
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
