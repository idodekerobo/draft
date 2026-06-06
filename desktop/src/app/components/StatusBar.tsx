// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Dot color thresholds (per DESIGN.md):
//   Green  = running + last capture < 30min ago
//   Yellow = running + last capture 30min–2hr ago, OR daemon degraded
//   Red    = daemon stopped, OR last capture > 2hr ago, OR never synced

import type { DaemonStatus } from "../../rpc/schema";

// ── Helpers ────────────────────────────────────────────────────────────────────

type DotVariant = "running" | "degraded" | "stopped";

function getDotVariant(status: DaemonStatus | null): DotVariant {
  if (!status || status.state === "stopped") return "stopped";
  if (status.state === "degraded") return "degraded";
  if (!status.lastSync) return "stopped"; // running but never synced → red

  const diffMins = (Date.now() - new Date(status.lastSync).getTime()) / 60_000;
  if (diffMins < 30)  return "running";
  if (diffMins < 120) return "degraded";
  return "stopped";
}

function getStatusText(status: DaemonStatus | null): string {
  if (!status) return "Connecting…";
  if (status.state === "stopped")  return "not running";
  if (status.state === "degraded") return "degraded";
  return "running";
}

function getConnectedCount(status: DaemonStatus | null): number {
  if (!status?.integrations) return 0;
  return [
    status.integrations.granola,
    status.integrations.slack,
    status.integrations.github,
  ].filter(Boolean).length;
}

// ── Component ──────────────────────────────────────────────────────────────────

interface StatusBarProps {
  status: DaemonStatus | null;
}

export function StatusBar({ status }: StatusBarProps) {
  const dotVariant     = getDotVariant(status);
  const statusText     = getStatusText(status);
  const connectedCount = getConnectedCount(status);

  return (
    <header className="status-bar electrobun-webkit-app-region-drag">
      <div className="status-bar__left">
        <span className={`status-bar__dot status-bar__dot--${dotVariant}`} />
        <span className="status-bar__text">{statusText}</span>

        {connectedCount > 0 && (
          <>
            <span className="status-bar__sep">·</span>
            <span className="status-bar__text">
              {connectedCount} {connectedCount === 1 ? "app" : "apps"} connected
            </span>
          </>
        )}
      </div>
    </header>
  );
}
