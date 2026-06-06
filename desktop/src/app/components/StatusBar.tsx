// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Dot color thresholds (per DESIGN.md):
//   Green  = running + last capture < 30min ago
//   Yellow = running + last capture 30min–2hr ago, OR daemon degraded
//   Red    = daemon stopped, OR last capture > 2hr ago, OR never synced
//
// Status line format (sidebar daemon control owns start/stop action):
//   Running  — "N connected"        (dot speaks for running, count is unique signal)
//   Degraded — "degraded · Xh ago"  (age makes the yellow state actionable)
//   Stopped  — dot only             (sidebar button handles the CTA)

import type { DaemonStatus } from "../../rpc/schema";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getConnectedCount(status: DaemonStatus | null): number {
  if (!status?.integrations) return 0;
  return [
    status.integrations.granola,
    status.integrations.slack,
    status.integrations.github,
  ].filter(Boolean).length;
}

function getStatusLine(status: DaemonStatus | null, connectedCount: number): string | null {
  if (!status) return "Connecting…";
  if (status.state === "stopped") return null;
  if (status.state === "degraded") {
    if (!status.lastSync) return "degraded";
    const diffMins = (Date.now() - new Date(status.lastSync).getTime()) / 60_000;
    if (diffMins >= 60) return `degraded · ${Math.floor(diffMins / 60)}h ago`;
    return `degraded · ${Math.round(diffMins)}m ago`;
  }
  // running
  if (connectedCount > 0) return `${connectedCount} connected`;
  return null;
}

// ── Component ──────────────────────────────────────────────────────────────────

interface StatusBarProps {
  status: DaemonStatus | null;
}

export function StatusBar({ status }: StatusBarProps) {
  const connectedCount = getConnectedCount(status);
  const statusLine     = getStatusLine(status, connectedCount);

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
