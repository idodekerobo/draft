// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Self-polls cloud data (same pattern as ActivityView.tsx):
//   Connected count — from getConnectedApps's cloud connections
//     (slack/fireflies/linear; claudeCode counted separately)
//   Last sync — most recent run from getWorkspaceRuns

import { useEffect, useRef, useState } from "react";
import type { ConnectedAppsStatus, WorkspaceRun } from "../../rpc/schema";
import { events, rpc } from "../rpc";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getConnectedCount(apps: ConnectedAppsStatus | null): number {
  if (!apps) return 0;
  const { slack, fireflies, linear } = apps.integrations;
  return [slack.connected, fireflies.connected, linear.connected, apps.claudeCode.connected]
    .filter(Boolean).length;
}

function getLastSyncLabel(run: WorkspaceRun | null): string | null {
  const ts = run?.completedAt ?? run?.startedAt ?? null;
  if (!ts) return null;
  const diffMins = (Date.now() - new Date(ts).getTime()) / 60_000;
  if (diffMins < 1) return "synced just now";
  if (diffMins < 60) return `synced ${Math.round(diffMins)}m ago`;
  return `synced ${Math.floor(diffMins / 60)}h ago`;
}

// ── Component ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

export function StatusBar() {
  const [apps, setApps]           = useState<ConnectedAppsStatus | null>(null);
  const [lastRun, setLastRun]     = useState<WorkspaceRun | null>(null);
  const isMounted                 = useRef(true);

  async function refresh() {
    try {
      const [appsResult, runs] = await Promise.all([
        rpc.request.getConnectedApps(),
        rpc.request.getWorkspaceRuns(),
      ]);
      if (!isMounted.current) return;
      setApps(appsResult);
      setLastRun(runs[0] ?? null);
    } catch {
      // Non-fatal — bar just shows nothing until the next poll succeeds.
    }
  }

  useEffect(() => {
    isMounted.current = true;
    void refresh();

    const offProfile = events.on("profileChanged", () => void refresh());

    function onVisibility() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisibility);

    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      isMounted.current = false;
      offProfile();
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, []);

  const connectedCount = getConnectedCount(apps);
  const lastSyncLabel  = getLastSyncLabel(lastRun);
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
}
