// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Displays: ● running · profile: acme · synced 4m ago
//
// Dot color reflects freshness (not just running/stopped):
//   Green  = running + last capture < 30min ago   (DESIGN.md thresholds)
//   Yellow = running + last capture 30min–2hr ago, OR daemon degraded
//   Red    = daemon stopped, OR last capture > 2hr ago, OR no sync yet

import type { DaemonStatus } from "../../rpc/schema";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: string | null | undefined): string {
  if (!ts) return "never synced";
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type DotVariant = "running" | "degraded" | "stopped";

function getDotVariant(status: DaemonStatus | null): DotVariant {
  if (!status || status.state === "stopped") return "stopped";
  if (status.state === "degraded") return "degraded";

  // Running — check freshness
  if (!status.lastSync) return "stopped"; // running but never synced → red

  const diffMins = (Date.now() - new Date(status.lastSync).getTime()) / 60_000;
  if (diffMins < 30)  return "running";   // green
  if (diffMins < 120) return "degraded";  // yellow
  return "stopped";                        // red (stale > 2hr)
}

function getStatusText(status: DaemonStatus | null): string {
  if (!status) return "Connecting…";
  if (status.state === "stopped")  return "not running";
  if (status.state === "degraded") return "degraded";
  return "running";
}

// ── Component ──────────────────────────────────────────────────────────────────

interface StatusBarProps {
  status: DaemonStatus | null;
}

export function StatusBar({ status }: StatusBarProps) {
  const dotVariant  = getDotVariant(status);
  const statusText  = getStatusText(status);
  const profileText = status?.profile ?? null;
  const syncText    = status?.lastSync ? formatRelativeTime(status.lastSync) : null;

  return (
    <header className="status-bar">
      <span className={`status-bar__dot status-bar__dot--${dotVariant}`} />
      <span className="status-bar__text">{statusText}</span>

      {profileText && (
        <>
          <span className="status-bar__sep">·</span>
          <span className="status-bar__text">profile: {profileText}</span>
        </>
      )}

      {syncText && (
        <>
          <span className="status-bar__sep">·</span>
          <span className="status-bar__text">synced {syncText}</span>
        </>
      )}
    </header>
  );
}
