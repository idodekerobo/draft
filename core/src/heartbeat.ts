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

/**
 * Read filesystem state to determine daemon health.
 * Does NOT invoke launchctl — callers who need a definitive running/stopped
 * answer should use getDaemonStatus() from ./status.ts instead.
 *
 * This function is intentionally fast (no subprocess) and suitable for
 * polling from a desktop tray or status bar.
 */
export function checkHeartbeat(): HeartbeatResult {
  // ── Pending queue depth ──────────────────────────────────────────────────────
  const pendingDir = `${BACKGROUND_DIR}/pending`;
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
  if (existsSync(DAEMON_LOG)) {
    try {
      const content = readFileSync(DAEMON_LOG, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      lastLogLine = lines[lines.length - 1] ?? null;
    } catch {
      lastLogLine = null;
    }
  }

  // ── Daemon running (PID sentinel file) ──────────────────────────────────────
  // The daemon writes its PID to background/daemon.pid on start and removes it on stop.
  // This is a fast heuristic — use getDaemonStatus() for a definitive launchctl check.
  const pidSentinel = `${BACKGROUND_DIR}/daemon.pid`;
  const daemonRunning = existsSync(pidSentinel);

  return { daemonRunning, lastLogLine, pendingQueueDepth };
}
