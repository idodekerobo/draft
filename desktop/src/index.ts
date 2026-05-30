// desktop/src/index.ts — Draft desktop app: Bun main process
//
// Spike scope (T0a): tray + main window + typed RPC + macOS notification.
// Full feature set built in phases per CEO plan.

import { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/bun";
import { getDaemonStatus } from "draft-core/status";
import { getActiveProfile } from "draft-core/config";
import type { AppRPCType } from "./rpc/schema";

// ── Tray ───────────────────────────────────────────────────────────────────────
// title-only for the spike. Replace with image asset before Phase 1 ship.
// Template image path (post-spike): "views://assets/tray-icon-template.png"

const tray = new Tray({ title: "Draft" });

tray.setMenu([
  { type: "normal",  label: "Open Draft",          action: "open"              },
  { type: "divider"                                                              },
  { type: "normal",  label: "Test Notification",    action: "test-notification" },
  { type: "divider"                                                              },
  { type: "normal",  label: "Quit",                 action: "quit"              },
]);

// ── RPC ────────────────────────────────────────────────────────────────────────
// Only spike endpoints are fully wired. Phase 2–4 handlers return stubs.

const rpc = BrowserView.defineRPC<AppRPCType>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      // ── SPIKE: wired ──────────────────────────────────────────────────────
      getStatus: async () => {
        return getDaemonStatus();
      },

      // ── STUBS: wired in later phases ─────────────────────────────────────
      getProposals: async () => [],

      launchSession: async () => ({
        ok: false,
        error: "not implemented — Phase 3",
      }),

      acceptProposal: async () => ({
        ok: false,
        error: "not implemented — Phase 2",
      }),

      rejectProposal: async () => ({
        ok: false,
        error: "not implemented — Phase 2",
      }),

      loadDiff: async () => ({
        entries: [],
        cursorLine: 0,
      }),
    },
    messages: {
      // ── SPIKE: wired ──────────────────────────────────────────────────────
      // Renderer asks bun to fire a native notification. Renderer has no
      // direct access to Utils — it goes through RPC.
      sendNotification: ({ title, subtitle, body }) => {
        Utils.showNotification({ title, subtitle, body });
      },
    },
  },
});

// ── Main window ────────────────────────────────────────────────────────────────

const win = new BrowserWindow({
  title: "Draft",
  url: "views://mainview/index.html",
  rpc,
});

// ── Tray event handling ────────────────────────────────────────────────────────

tray.on("tray-clicked", (e) => {
  const { action } = (e as { data: { id?: string; action: string } }).data;

  if (action === "open" || action === "") {
    // action === "" fires when the tray icon itself is clicked (not a menu item).
    win.show?.();
  }

  if (action === "test-notification") {
    // Prove Utils.showNotification works directly from the tray (no RPC needed).
    Utils.showNotification({
      title: "Draft",
      subtitle: "Spike test",
      body: "Tray → notification ✓",
    });
  }

  if (action === "quit") {
    process.exit(0);
  }
});

// ── Startup log ───────────────────────────────────────────────────────────────
// Quick sanity check on startup. Phase 1 will push this to renderer via
// webview.messages once the dom-ready event is wired.

setTimeout(async () => {
  try {
    const status  = await getDaemonStatus();
    const profile = getActiveProfile();
    console.log(`[draft-desktop] daemon=${status.state} profile=${profile}`);
  } catch (err) {
    console.error("[draft-desktop] startup status check failed:", err);
  }
}, 500);
