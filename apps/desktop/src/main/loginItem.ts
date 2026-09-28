// desktop/src/main/loginItem.ts — macOS Login Item management via osascript
//
// Adds/removes Draft from System Settings → General → Login Items using
// AppleScript (System Events). Requires the macOS Automation permission —
// the user will see a one-time permission dialog on first use.
//
// Dev mode: process.execPath points to the Bun runtime, not a .app bundle.
// getAppBundlePath() returns "" in that case and applyLoginItem() no-ops
// silently. The preference is still saved to local.json; the OS-level login
// item is only registered when running as a packaged .app.

import { capture } from "draft-core/exec";

/**
 * Walks up process.execPath to find the enclosing .app bundle root.
 * Returns "" if no .app boundary is found (dev mode / bare Bun process).
 *
 * Example:
 *   execPath = /Applications/Draft.app/Contents/MacOS/Draft
 *   returns  = /Applications/Draft.app
 */
export function getAppBundlePath(): string {
  const execPath = process.execPath;
  const marker = ".app/";
  const idx = execPath.indexOf(marker);
  if (idx === -1) return "";
  return execPath.slice(0, idx + marker.length - 1); // trim trailing slash
}

/**
 * Add or remove Draft from macOS Login Items via System Events AppleScript.
 * Silently no-ops if not running from a packaged .app bundle.
 */
export async function applyLoginItem(enabled: boolean): Promise<void> {
  const appPath = getAppBundlePath();
  if (!appPath) return;

  try {
    if (enabled) {
      await capture([
        "osascript", "-e",
        `tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:false}`,
      ]);
    } else {
      await capture([
        "osascript", "-e",
        `tell application "System Events" to delete login item "Draft"`,
      ]);
    }
  } catch {
    // Non-fatal — Automation permission denied or System Events unavailable.
    // The preference is already saved to local.json; the user can retry by
    // toggling the setting again after granting the Automation permission.
  }
}
