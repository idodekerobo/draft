// desktop/src/index.ts — Draft desktop app: Bun main process

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Tray, Utils } from "electrobun/bun";
import { getDaemonStatus, PLIST_LABEL, PLIST_PATH } from "draft-core/status";
import { getAppState } from "draft-core/appState";
import { getActiveProfile, getProfiles, getWorkspacePath, setActiveProfile, readIntegrations, writeIntegrations, readDraftConfig, getInstalledTools, BACKGROUND_DIR } from "draft-core/config";
import { capture } from "draft-core/exec";
import {
  listProposals,
  parseProposal,
  acceptProposal as acceptCoreProposal,
  rejectProposal as rejectCoreProposal,
} from "draft-core/proposals";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { readLocalConfig, writeLocalConfig } from "draft-core/config";
import { readLocalDiff, fetchRemoteDiff, applyFromTmpDir } from "./main/sync/loadDiff";
import { runInstall } from "./main/installer";
import { startHeartbeatWatch, stopHeartbeatWatch, setNotificationsEnabled } from "./main/notifications";
import { applyLoginItem } from "./main/loginItem";
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

// ── Application menu ───────────────────────────────────────────────────────────

function setAppMenu(daemonRunning: boolean) {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [
        daemonRunning
          ? { label: "Stop Draft",  action: "stop-draft"  }
          : { label: "Start Draft", action: "start-draft" },
        { type: "separator" },
        { label: "Quit Draft", action: "quit-app", accelerator: "q" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "copy" }],
    },
  ]);
}

async function refreshAppMenu() {
  try {
    const s = await getDaemonStatus();
    setAppMenu(s.state === "running");
  } catch { /* non-fatal */ }
}

// Render with default state immediately; startup check corrects it.
setAppMenu(true);

Electrobun.events.on("application-menu-clicked", (event) => {
  const { action } = (event as { data: { action: string } }).data;

  if (action === "stop-draft") {
    capture(["launchctl", "stop", PLIST_LABEL])
      .then(() => {
        setTimeout(refreshAppMenu, 500);
        try { rpc.send.requestStatusRefresh({}); } catch {}
      })
      .catch(() => {});
  }

  if (action === "start-draft") {
    if (existsSync(PLIST_PATH)) {
      Bun.spawn(["bash", `${BACKGROUND_DIR}/start.sh`], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      setTimeout(refreshAppMenu, 1500);
      try { rpc.send.requestStatusRefresh({}); } catch {}
    }
  }

  if (action === "quit-app") {
    stopHeartbeatWatch();
    stopProposalWatch();
    stopActiveProfileWatch();
    process.exit(0);
  }
});

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

// Staging temp dir held between getTeamDiff (phase 1) and applyTeamDiff (phase 2).
// Module-level so it survives across RPC calls. Cleaned up on next getTeamDiff call
// or on applyTeamDiff. Empty string = no staging dir.
let stagingTmpDir = "";

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

        const toolList = getInstalledTools();
        const installedTools = {
          "claude-code": toolList.includes("claude-code"),
          codex:         toolList.includes("codex"),
          cursor:        toolList.includes("cursor"),
        };

        return { ...daemonStatus, profile, lastSync, appState, integrations, installedTools };
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
        setTimeout(refreshAppMenu, 1500);
        return { ok: true };
      },

      stopDaemon: async () => {
        const result = await capture(["launchctl", "stop", PLIST_LABEL]);
        refreshAppMenu().catch(() => {});
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

      loadDiff: async () => {
        const result = readLocalDiff();
        return result;
      },

      getTeamDiff: async () => {
        // Clean up any lingering staging dir before starting a fresh clone.
        if (stagingTmpDir) {
          try { (await import("fs")).rmSync(stagingTmpDir, { recursive: true, force: true }); } catch {}
          stagingTmpDir = "";
        }
        const result = await fetchRemoteDiff();
        if (result.tmpDir) stagingTmpDir = result.tmpDir;
        return result;
      },

      applyTeamDiff: async ({ tmpDir, cursorLine }) => {
        const result = applyFromTmpDir(tmpDir, cursorLine);
        if (stagingTmpDir === tmpDir) stagingTmpDir = "";
        return result;
      },

      getLocalConfig: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const result = readLocalConfig(workspace);
        const c = result.ok ? result.config : {};
        return {
          teamLoadMode:        c.teamLoadMode        ?? "auto",
          launchOnLogin:       c.launchOnLogin       ?? false,
          notificationsEnabled: c.notificationsEnabled ?? true,
        };
      },

      setLocalConfig: async (patch) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          writeLocalConfig(workspace, patch);
          if (patch.launchOnLogin !== undefined) {
            await applyLoginItem(patch.launchOnLogin);
          }
          if (patch.notificationsEnabled !== undefined) {
            setNotificationsEnabled(patch.notificationsEnabled);
          }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Write failed." };
        }
      },

      getContextFiles: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const contextDir = join(workspace, "context");
        if (!existsSync(contextDir)) return [];

        const SKIP_ROOT = new Set(["log", "accepted", "rejected"]);
        const DIMENSION_ORDER = ["company", "product", "team", "priorities"];

        function capitalize(str: string): string {
          return str.replace(/\b\w/g, (c) => c.toUpperCase());
        }

        function slugToLabel(slug: string): string {
          return capitalize(slug.replace(/[-_]/g, " "));
        }

        function stripFrontmatter(content: string): string {
          if (!content.startsWith("---")) return content;
          const end = content.indexOf("\n---", 3);
          if (end === -1) return content;
          return content.slice(end + 4).replace(/^\n/, "");
        }

        function logEntryLabel(filename: string): string {
          const base = filename.replace(/\.md$/, "");
          // Expect prefix like 20260514_ or 20260514-
          const match = base.match(/^(\d{4})(\d{2})(\d{2})[_-]/);
          if (match) {
            const [, year, month, day] = match;
            const date = new Date(Number(year), Number(month) - 1, Number(day));
            return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
          }
          return slugToLabel(base);
        }

        const entries: import("./rpc/schema").ContextFileEntry[] = [];

        let topLevel: string[];
        try {
          topLevel = readdirSync(contextDir);
        } catch {
          return [];
        }

        for (const name of topLevel) {
          if (SKIP_ROOT.has(name)) continue;
          const fullPath = join(contextDir, name);
          let stat;
          try { stat = statSync(fullPath); } catch { continue; }

          if (stat.isDirectory()) {
            const indexPath = join(fullPath, "index.md");
            const hasIndex = existsSync(indexPath);

            if (hasIndex) {
              // Dimension dir — emit index.md as "dim" entry
              let content = "";
              try { content = readFileSync(indexPath, "utf8"); } catch { /* empty */ }
              entries.push({
                relativePath: `${name}/index.md`,
                label: slugToLabel(name),
                content: stripFrontmatter(content),
                kind: "dim",
                group: name,
                groupLabel: slugToLabel(name),
              });

              // Walk log/ subdir for log entries
              const logDir = join(fullPath, "log");
              if (existsSync(logDir)) {
                let logFiles: string[];
                try { logFiles = readdirSync(logDir); } catch { logFiles = []; }
                const mdLogFiles = logFiles.filter((f) => f.endsWith(".md")).sort().reverse();
                for (const lf of mdLogFiles) {
                  const lfPath = join(logDir, lf);
                  let lfContent = "";
                  try { lfContent = readFileSync(lfPath, "utf8"); } catch { continue; }
                  entries.push({
                    relativePath: `${name}/log/${lf}`,
                    label: logEntryLabel(lf),
                    content: stripFrontmatter(lfContent),
                    kind: "log",
                    group: name,
                    groupLabel: slugToLabel(name),
                  });
                }
              }
            } else {
              // Group dir — all .md files as group-child entries
              let children: string[];
              try { children = readdirSync(fullPath); } catch { continue; }
              const mdChildren = children.filter((c) => c.endsWith(".md")).sort();
              for (const child of mdChildren) {
                const childPath = join(fullPath, child);
                let childContent = "";
                try { childContent = readFileSync(childPath, "utf8"); } catch { continue; }
                const childBase = child.replace(/\.md$/, "");
                entries.push({
                  relativePath: `${name}/${child}`,
                  label: slugToLabel(childBase),
                  content: stripFrontmatter(childContent),
                  kind: "group-child",
                  group: name,
                  groupLabel: slugToLabel(name),
                });
              }
            }
          } else if (name.endsWith(".md")) {
            let fileContent = "";
            try { fileContent = readFileSync(fullPath, "utf8"); } catch { continue; }
            const base = name.replace(/\.md$/, "");
            entries.push({
              relativePath: name,
              label: slugToLabel(base),
              content: stripFrontmatter(fileContent),
              kind: "standalone",
              group: base,
              groupLabel: slugToLabel(base),
            });
          }
        }

        // Sort order:
        //   1. Standard dims (company → product → team → priorities), then their log entries
        //   2. Other dims with index.md (alphabetical), then their log entries
        //   3. Standalone files
        //   4. Group-child entries (by group, then filename)
        entries.sort((a, b) => {
          function sortKey(e: import("./rpc/schema").ContextFileEntry): [number, number, string, string] {
            const stdIdx = DIMENSION_ORDER.indexOf(e.group);
            if (e.kind === "dim") {
              return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 0, e.group, ""];
            }
            if (e.kind === "log") {
              return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 1, e.group, e.relativePath];
            }
            if (e.kind === "standalone") {
              return [200, 0, e.group, ""];
            }
            // group-child
            return [300, 0, e.group, e.relativePath];
          }
          const ka = sortKey(a);
          const kb = sortKey(b);
          for (let i = 0; i < ka.length; i++) {
            const av = ka[i];
            const bv = kb[i];
            if (av === undefined || bv === undefined) break;
            if (av < bv) return -1;
            if (av > bv) return 1;
          }
          return 0;
        });

        return entries;
      },

      getConnectedApps: async () => {
        // Tools — read from global config.json (not per-profile)
        const cfgResult = readDraftConfig();
        const toolsCfg  = cfgResult.ok ? cfgResult.config.tools : {};

        function toolDetail(key: "claude-code" | "codex" | "cursor") {
          const entry = toolsCfg[key];
          return {
            installed: !!entry,
            addedAt:   entry?.added_at ?? null,
          };
        }

        // Integrations — read from per-profile integrations.json
        const workspace  = getWorkspacePath(getActiveProfile());
        const intResult  = readIntegrations(workspace);
        const int        = intResult.ok ? intResult.integrations : {};

        function integrationDetail(key: "granola" | "slack" | "github") {
          const entry = int[key];
          return {
            connected:     entry?.connected    ?? false,
            lastConnected: entry?.last_connected ?? null,
            mode:          entry?.mode          ?? null,
            channels:      entry?.channels      ?? null,
            repos:         entry?.repos         ?? [],
          };
        }

        return {
          tools: {
            "claude-code": toolDetail("claude-code"),
            codex:         toolDetail("codex"),
            cursor:        toolDetail("cursor"),
          },
          integrations: {
            granola: integrationDetail("granola"),
            slack:   integrationDetail("slack"),
            github:  integrationDetail("github"),
          },
        };
      },

      disconnectIntegration: async ({ source }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const result    = readIntegrations(workspace);
          const current   = result.ok ? result.integrations : {};
          const updated   = {
            ...current,
            [source]: { ...(current[source] ?? {}), connected: false },
          };
          writeIntegrations(workspace, updated);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Disconnect failed." };
        }
      },

      connectGitHub: async () => {
        // Fast path: gh already authenticated — just mark connected in integrations.json.
        const authCheck = await capture(["gh", "auth", "status"]);
        if (authCheck.exitCode === 0) {
          try {
            const workspace = getWorkspacePath(getActiveProfile());
            const result    = readIntegrations(workspace);
            const current   = result.ok ? result.integrations : {};
            writeIntegrations(workspace, {
              ...current,
              github: { ...(current.github ?? {}), connected: true, last_connected: new Date().toISOString() },
            });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : "Failed to save GitHub connection." };
          }
        }

        // Slow path: open browser OAuth flow. Fire-and-forget — return immediately
        // so the renderer doesn't wait on a 30s+ user interaction.
        // Background promise writes integrations.json when gh exits cleanly.
        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(["gh", "auth", "login", "--web"], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
        } catch {
          return { ok: false, error: "gh CLI not found. Install it with: brew install gh" };
        }

        // Background: when OAuth completes, persist the connection.
        proc.exited.then((code) => {
          if (code !== 0) return;
          try {
            const workspace = getWorkspacePath(getActiveProfile());
            const result    = readIntegrations(workspace);
            const current   = result.ok ? result.integrations : {};
            writeIntegrations(workspace, {
              ...current,
              github: { ...(current.github ?? {}), connected: true, last_connected: new Date().toISOString() },
            });
          } catch { /* non-fatal */ }
        }).catch(() => {});

        // Renderer should poll getConnectedApps until github.connected === true.
        return { ok: true };
      },

      runInstall: async ({ tools }) => {
        return runInstall(tools);
      },
    },
    messages: {
      sendNotification: ({ title, subtitle, body }) => {
        Utils.showNotification({ title, subtitle, body });
      },
      openUrl: ({ url }) => {
        Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
    setAppMenu(status.state === "running");
  } catch (err) {
    console.error("[draft-desktop] startup status check failed:", err);
  }

  // Apply persisted notification preference before starting any watchers so
  // the first heartbeat check already respects the user's setting.
  const wsPath = getWorkspacePath(getActiveProfile());
  const localCfg = readLocalConfig(wsPath);
  if (localCfg.ok && localCfg.config.notificationsEnabled === false) {
    setNotificationsEnabled(false);
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
