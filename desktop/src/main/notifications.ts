// desktop/src/main/notifications.ts — macOS notification triggers
//
// Trigger 1: notifyNewProposal(source, count)
// Trigger 2: daemon stopped — self-contained: watches last-heartbeat mtime, fires at 2min stale
// Trigger 3: notifyCaptureComplete(source)
//
// Uses Utils.showNotification (legacy NSUserNotificationCenter — sidebar only).
// Banner notifications via UNUserNotificationCenter deferred post-v1.
//
// Design note: if the heartbeat file does not exist on startup (daemon was never
// started), no timer is armed and no notification fires. The "daemon never started"
// state is surfaced visually via the status header, not via notification.

import { Utils } from "electrobun/bun";
import { existsSync, statSync, watch } from "fs";
import { BACKGROUND_DIR } from "draft-core/config";

const STATE_DIR      = `${BACKGROUND_DIR}/state`;
const HEARTBEAT_PATH = `${STATE_DIR}/last-heartbeat`;
const STALE_MS       = 2 * 60 * 1000; // 2 minutes

// ── Notification gate ──────────────────────────────────────────────────────────
// Controlled by the user's notificationsEnabled setting in local.json.
// Set on startup and updated immediately when the setting changes in the UI.

let notificationsEnabled = true;

export function setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled = enabled;
}

function showNotif(opts: { title: string; subtitle?: string; body?: string }): void {
  if (!notificationsEnabled) return;
  Utils.showNotification(opts);
}

// ── Public notification functions ──────────────────────────────────────────────
// Called by watcher code when the relevant fs.watch events fire.

export function notifyNewProposal(source: string, count: number): void {
  showNotif({
    title: "Draft",
    body:  `${count} new proposal${count === 1 ? "" : "s"} from ${source}`,
  });
}

export function notifyCaptureComplete(source: string): void {
  showNotif({
    title: "Draft",
    body:  `${source} captured, proposals ready`,
  });
}

// ── Heartbeat staleness watcher ────────────────────────────────────────────────
// On each daemon poll cycle, the daemon writes ~/.draft/background/state/last-heartbeat.
// If the file's mtime goes stale by >2min, the daemon has stopped — fire a notification.
//
// Implementation: watch the state/ directory (more robust than watching the file
// directly — handles file creation after startup). Filter events for "last-heartbeat".
// Each event resets the 2min stale timer.

let staleTimer:       ReturnType<typeof setTimeout> | null = null;
let heartbeatWatcher: ReturnType<typeof watch>      | null = null;
let stoppedFired = false;

function armStaleTimer(): void {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    if (!stoppedFired) {
      stoppedFired = true;
      showNotif({ title: "Draft", body: "Draft daemon stopped" });
    }
  }, STALE_MS);
}

function onHeartbeatReceived(): void {
  stoppedFired = false;
  armStaleTimer();
}

export function startHeartbeatWatch(): void {
  // ── Initial staleness check ──────────────────────────────────────────────────
  // Fire immediately if heartbeat is already stale when the app opens.
  // If the file doesn't exist (daemon never run), skip — no notification.
  if (existsSync(HEARTBEAT_PATH)) {
    const ageMs = Date.now() - statSync(HEARTBEAT_PATH).mtimeMs;
    if (ageMs > STALE_MS) {
      stoppedFired = true;
      showNotif({ title: "Draft", body: "Draft daemon stopped" });
    } else {
      armStaleTimer();
    }
  }

  // ── fs.watch on state/ directory ────────────────────────────────────────────
  // Watching the directory (not the file) means we catch file creation too.
  // persistent: false — watcher doesn't need to keep the process alive (tray does).
  if (!existsSync(STATE_DIR)) return;
  try {
    heartbeatWatcher = watch(STATE_DIR, { persistent: false }, (_, filename) => {
      if (filename === "last-heartbeat") onHeartbeatReceived();
    });
  } catch {
    // Non-fatal — stale timer still fires if file existed at startup.
  }
}

export function stopHeartbeatWatch(): void {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  heartbeatWatcher?.close();
  heartbeatWatcher = null;
}
