// desktop/src/index.ts — Draft desktop app: Bun main process

import { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/bun";
import { getDaemonStatus, PLIST_LABEL, PLIST_PATH } from "draft-core/status";
import { getAppState } from "draft-core/appState";
import { getActiveProfile, getProfiles, getWorkspacePath, setActiveProfile, readIntegrations, BACKGROUND_DIR } from "draft-core/config";
import { capture } from "draft-core/exec";
import {
  listProposals,
  parseProposal,
  acceptProposal as acceptCoreProposal,
  rejectProposal as rejectCoreProposal,
} from "draft-core/proposals";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { startHeartbeatWatch, stopHeartbeatWatch } from "./main/notifications";
import {
  startProposalWatch,
  restartProposalWatch,
  stopProposalWatch,
  type ProposalWatchHandlers,
} from "./main/watchers/proposals";
import {
  startActiveProfileWatch,
  stopActiveProfileWatch,
} from "./main/watchers/activeProfile";
import type { AppRPCType } from "./rpc/schema";

// ── Tray ───────────────────────────────────────────────────────────────────────
// TODO: Replace with image asset before Phase 1 ship (put image in "views://assets/tray-icon-template.png")

const tray = new Tray({ title: "Draft" });

tray.setMenu([
  { type: "normal",  label: "Open Draft",          action: "open"              },
  { type: "divider"                                                              },
  { type: "normal",  label: "Test Notification",    action: "test-notification" },
  { type: "divider"                                                              },
  { type: "normal",  label: "Quit",                 action: "quit"              },
]);

// ── RPC ────────────────────────────────────────────────────────────────────────
// watcherHandlers is forward-declared here so switchProfile can reference it.
// It is assigned immediately after rpc is constructed — before any handler fires.

// eslint-disable-next-line prefer-const
let watcherHandlers!: ProposalWatchHandlers;

const rpc = BrowserView.defineRPC<AppRPCType>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      getStatus: async () => {
        const daemonStatus = await getDaemonStatus();
        const appState = getAppState();

        // Enrich with heartbeat JSON for profile + lastSync display
        let profile: string | null = null;
        let lastSync: string | null = null;
        try {
          const heartbeatPath = `${process.env.HOME}/.draft/background/state/last-heartbeat`;
          const raw = await Bun.file(heartbeatPath).text();
          const hb = JSON.parse(raw) as {
            pid?: number;
            profile?: string;
            ts?: string;
            last_sync?: string;
          };
          profile  = hb.profile  ?? null;
          lastSync = hb.last_sync || null; // empty string → null
        } catch {
          // file missing or malformed — daemon hasn't run yet
        }

        const workspace = getWorkspacePath(getActiveProfile());
        const intResult = readIntegrations(workspace);
        const int = intResult.ok ? intResult.integrations : {};
        const integrations = {
          granola: int.granola?.connected ?? false,
          slack:   int.slack?.connected   ?? false,
          github:  int.github?.connected  ?? false,
        };

        return { ...daemonStatus, profile, lastSync, appState, integrations };
      },

      getProposals: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        return listProposals(workspace).map((proposal) => ({
          filename: proposal.filename,
          source: proposal.source,
          dimension: proposal.dimension,
          action: proposal.action,
          timestamp: proposal.timestamp,
          summary: proposal.summary,
          createdAt: proposal.createdAt,
          body: proposal.body,
          currentContent: readContextFile(workspace, proposal.dimension),
        }));
      },

      getProfiles: async () => getProfiles(),

      switchProfile: async ({ profile }) => {
        const result = setActiveProfile(profile);
        if (!result.ok) {
          return { ok: false, error: result.reason };
        }
        restartProposalWatch(result.active, watcherHandlers);
        try { rpc.send.profileChanged({ profile: result.active }); } catch {}
        return { ok: true, active: result.active };
      },

      launchSession: async () => ({
        ok: false,
        error: "not implemented — Phase 3",
      }),

      startDaemon: async () => {
        // Delegates to start.sh (same as `draft start` in the CLI).
        // We ignore start.sh's own exit code as the success signal — its
        // internal sleep 1 + verify check races the daemon's actual startup
        // and produces false-negative exits even when the daemon does start.
        // Plist missing = not installed. Fast check before spawning anything.
        if (!existsSync(PLIST_PATH)) {
          return { ok: false, error: "Draft is not installed. Run install.sh first." };
        }

        // Spawn start.sh but only wait 300ms for it to exit.
        // Fast-fail branches (bad config, etc.) finish in < 100ms — we surface those.
        // The launchctl load + sleep 1 slow path takes > 1s, so we let it keep
        // running and return ok:true immediately. The renderer polls getStatus()
        // independently, avoiding Electrobun's short renderer-side RPC timeout.
        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(["bash", `${BACKGROUND_DIR}/start.sh`], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
        } catch {
          return { ok: false, error: "Failed to launch start.sh." };
        }

        const timedOut = await Promise.race([
          proc.exited.then(() => false),
          Bun.sleep(300).then(() => true),
        ]);

        if (!timedOut) {
          const code = await proc.exited; // already resolved — instant
          if (code !== 0) {
            const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
            return { ok: false, error: stderr.trim() || "Failed to start Draft." };
          }
        }

        // Slow path still running, or fast success — renderer polls getStatus().
        return { ok: true };
      },

      stopDaemon: async () => {
        const result = await capture(["launchctl", "stop", PLIST_LABEL]);
        return { ok: result.exitCode === 0, error: result.stderr || undefined };
      },

      acceptProposal: async ({ filename }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const proposalPath = join(workspace, "proposals", filename);
          const proposal = parseProposal(filename, proposalPath);
          acceptCoreProposal(proposal, join(workspace, "accepted"));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Accept failed" };
        }
      },

      rejectProposal: async ({ filename }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const proposalPath = join(workspace, "proposals", filename);
          const proposal = parseProposal(filename, proposalPath);
          rejectCoreProposal(proposal, join(workspace, "rejected"));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Reject failed" };
        }
      },

      loadDiff: async () => ({
        entries: [],
        cursorLine: 0,
      }),
    },
    messages: {
      // Renderer asks bun to fire a native notification. Renderer has no direct access to Utils — it goes through RPC.
      sendNotification: ({ title, subtitle, body }) => {
        Utils.showNotification({ title, subtitle, body });
      },
    },
  },
});

// Assign after rpc is constructed so rpc.send is available in the closures,
// but before any handler or watcher fires.
watcherHandlers = {
  onBadgeUpdate: (profile, count) => {
    try { rpc.send.badgeUpdate({ profile, count }); } catch {}
  },
  onProposalAdded: (profile, source, count) => {
    try { rpc.send.proposalAdded({ profile, source, count }); } catch {}
  },
};

// ── Main window ────────────────────────────────────────────────────────────────

const win = new BrowserWindow({
  title: "Draft",
  url: "views://app/index.html",
  rpc,
});
win.setFrame(180, 100, 1150, 820);

function readContextFile(workspace: string, dimension: string): string {
  if (!dimension || dimension === "unknown") return "";
  const contextPath = join(workspace, "context", dimension, "index.md");
  if (!existsSync(contextPath)) return "";
  try {
    return readFileSync(contextPath, "utf8");
  } catch {
    return "";
  }
}

// ── Tray event handling ────────────────────────────────────────────────────────

tray.on("tray-clicked", (e) => {
  const { action } = (e as { data: { id?: string; action: string } }).data;

  if (action === "open" || action === "") {
    // action === "" fires when the tray icon itself is clicked (not a menu item).
    win.show?.();
  }

  if (action === "test-notification") {
    Utils.showNotification({
      title: "Draft",
      subtitle: "Spike test",
      body: "Tray → notification ✓",
    });
  }

  if (action === "quit") {
    stopHeartbeatWatch();
    stopProposalWatch();
    stopActiveProfileWatch();
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

  // Start heartbeat staleness watcher.
  // 500ms delay ensures app is fully initialised before the initial mtime check.
  startHeartbeatWatch();
  startProposalWatch(getActiveProfile(), watcherHandlers);

  // Watch ~/.draft/active-profile for CLI-driven profile switches (e.g. `draft switch`).
  startActiveProfileWatch({
    onProfileChanged: (profile) => {
      restartProposalWatch(profile, watcherHandlers);
      try { rpc.send.profileChanged({ profile }); } catch {}
    },
  });
}, 500);
