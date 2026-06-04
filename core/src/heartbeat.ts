// core/src/heartbeat.ts — daemon health check beyond "is launchctl showing a PID"
//
// Used by: draft-cli (commands/doctor.ts), draft-desktop (tray status indicator)
// Pure filesystem reads — no shell exec. Fast and safe to call frequently.

import { existsSync, readdirSync, readFileSync } from "fs";
import { BACKGROUND_DIR } from "./config";
import { DAEMON_LOG } from "./status";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HeartbeatResult {
  /** True if launchctl reported a running PID (fast check via filesystem sentinel) */
  daemonRunning: boolean;
  /** Most recent non-empty line from daemon.log, or null if log is missing/empty */
  lastLogLine: string | null;
  /** Number of job files currently waiting in pending/ queue */
  pendingQueueDepth: number;
}

// ── Check ──────────────────────────────────────────────────────────────────────

export interface HeartbeatOpts {
  /** Override the background dir path. Used in tests. */
  backgroundDir?: string;
  /** Override the daemon log path. Used in tests. */
  daemonLog?: string;
}

/**
 * Read filesystem state to determine daemon health.
 * Does NOT invoke launchctl — callers who need a definitive running/stopped
 * answer should use getDaemonStatus() from ./status.ts instead.
 *
 * This function is intentionally fast (no subprocess) and suitable for
 * polling from a desktop tray or status bar.
 *
 * Pass `opts` to override path constants (useful in tests).
 */
export function checkHeartbeat(opts?: HeartbeatOpts): HeartbeatResult {
  const bgDir   = opts?.backgroundDir ?? BACKGROUND_DIR;
  const logFile = opts?.daemonLog     ?? DAEMON_LOG;

  // ── Pending queue depth ──────────────────────────────────────────────────────
  const pendingDir = `${bgDir}/pending`;
  let pendingQueueDepth = 0;
  if (existsSync(pendingDir)) {
    try {
      pendingQueueDepth = readdirSync(pendingDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      pendingQueueDepth = 0;
    }
  }

  // ── Last log line ────────────────────────────────────────────────────────────
  let lastLogLine: string | null = null;
  if (existsSync(logFile)) {
    try {
      const content = readFileSync(logFile, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      lastLogLine = lines[lines.length - 1] ?? null;
    } catch {
      lastLogLine = null;
    }
  }

  // ── Daemon running (PID sentinel file) ──────────────────────────────────────
  // The daemon writes its PID to background/draft-background.pid on start and removes it on stop.
  // This is a fast heuristic — use getDaemonStatus() for a definitive launchctl check.
  const pidSentinel = `${bgDir}/draft-background.pid`;
  const daemonRunning = existsSync(pidSentinel);

  return { daemonRunning, lastLogLine, pendingQueueDepth };
}
