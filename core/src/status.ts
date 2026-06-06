// core/src/status.ts — daemon status types, path constants, and query logic
//
// Used by: draft-cli (commands/daemon.ts, commands/doctor.ts), draft-desktop (tray + settings panel)

import { BACKGROUND_DIR } from "./config";
import { capture } from "./exec";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PLIST_LABEL    = "com.draft.daemon";
export const PLIST_PATH     = `${process.env.HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
export const DAEMON_LOG     = `${BACKGROUND_DIR}/logs/daemon.log`;
export const DAEMON_ERR_LOG = `${BACKGROUND_DIR}/logs/daemon-error.log`;

// ── Types ──────────────────────────────────────────────────────────────────────

export type DaemonState = "running" | "stopped" | "degraded";

export interface DaemonStatus {
  state: DaemonState;
  pid: string | null;
  lastExit: string | null;
  isRegistered: boolean;
}

// ── Query ──────────────────────────────────────────────────────────────────────

/**
 * Query launchctl for the daemon's current state.
 * Returns a typed DaemonStatus — callers don't need to parse launchctl output.
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const result = await capture(["launchctl", "list", PLIST_LABEL]);
  const isRegistered = result.exitCode === 0;

  let pid: string | null = null;
  let lastExit: string | null = null;

  if (isRegistered) {
    const pidMatch  = result.stdout.match(/"PID"\s*=\s*(\d+)/);
    const exitMatch = result.stdout.match(/"LastExitStatus"\s*=\s*(\d+)/);
    pid      = pidMatch?.[1]  ?? null;
    lastExit = exitMatch?.[1] ?? null;
  }

  const isRunning = isRegistered && pid !== null;
  const state: DaemonState = isRunning
    ? "running"
    : isRegistered
      ? "degraded"
      : "stopped";

  return { state, pid, lastExit, isRegistered };
}
