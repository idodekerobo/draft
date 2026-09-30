// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Reads two shared queries (also used by Activity and Connections):
//   Connected count — from getConnectedApps's cloud connections
//     (slack/fireflies/linear; claudeCode counted separately)
//   Last sync — most recent run from getWorkspaceRuns

import { memo, useEffect, useState } from "react";
import { runsQueryOptions, useDraftApi, useQuery } from "draft-shared-ui";
import type { ConnectedAppsStatus, WorkspaceRun } from "../../rpc/schema";
import { useWorkspaceKey } from "../DesktopQueryProvider";
import { useConnectedApps } from "../hooks/useConnectedApps";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getConnectedCount(apps: ConnectedAppsStatus | null): number {
  if (!apps) return 0;
  const { slack, fireflies, linear } = apps.integrations;
  return [slack.connected, fireflies.connected, linear.connected, apps.claudeCode.connected]
    .filter(Boolean).length;
}

function getLastSyncLabel(run: Pick<WorkspaceRun, "completedAt" | "startedAt"> | null): string | null {
  const ts = run?.completedAt ?? run?.startedAt ?? null;
  if (!ts) return null;
  const diffMins = (Date.now() - new Date(ts).getTime()) / 60_000;
  if (diffMins < 1) return "synced just now";
  if (diffMins < 60) return `synced ${Math.round(diffMins)}m ago`;
  return `synced ${Math.floor(diffMins / 60)}h ago`;
}

// ── Component ──────────────────────────────────────────────────────────────────

// Non-critical, so it uses plain queries: blank while loading or on error,
// and it fills in once a poll succeeds.
export const StatusBar = memo(function StatusBar() {
  const { apps } = useConnectedApps();
  // The label is relative to now, and unchanged poll data would not re-render it.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const { data: runs } = useQuery(runsQueryOptions(useDraftApi(), useWorkspaceKey()));

  const connectedCount = getConnectedCount(apps);
  const lastSyncLabel  = getLastSyncLabel(runs?.[0] ?? null);
  const statusLine     = connectedCount > 0
    ? `${connectedCount} connected${lastSyncLabel ? ` · ${lastSyncLabel}` : ""}`
    : lastSyncLabel;

  return (
    <header className="status-bar electrobun-webkit-app-region-drag">
      <div className="status-bar__left">
        {statusLine && (
          <span className="status-bar__text">{statusLine}</span>
        )}
      </div>
    </header>
  );
});
