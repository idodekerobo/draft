// desktop/src/main/notifications.ts — macOS notification triggers
//
// Uses Utils.showNotification (legacy NSUserNotificationCenter — sidebar only).
// Banner notifications via UNUserNotificationCenter deferred post-v1.

import { Utils } from "electrobun/bun";

// ── Notification gate ──────────────────────────────────────────────────────────
// Controlled by the user's notificationsEnabled setting in local.json.
// Set on startup and updated immediately when the setting changes in the UI.

let notificationsEnabled = true;

export function setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled = enabled;
}

export function showNotif(opts: { title: string; subtitle?: string; body?: string }): void {
  if (!notificationsEnabled) return;
  Utils.showNotification(opts);
}
