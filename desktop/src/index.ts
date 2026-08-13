// desktop/src/index.ts — Draft desktop app: Bun main process

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Tray, Utils } from "electrobun/bun";
import { getDaemonStatus, PLIST_LABEL, PLIST_PATH } from "draft-core/status";
import {
  createSymlinks, removeSymlinks, scanSkillDirectories, scanMCPConnections,
  detectPending, reconcileSkillManifest, readSkillManifest, writeSkillManifest,
  type PendingSkillEntry, type SameNameConflict,
} from "draft-core/scanner";
import { getAppState } from "draft-core/appState";
import { getActiveProfile, getProfiles, getWorkspacePath, createProfile, readIntegrations, writeIntegrations, readDraftConfig, writeDraftConfig, ensureAnalyticsConfig, getInstalledTools, BACKGROUND_DIR, DRAFT_ROOT, type AnalyticsConfig } from "draft-core/config";
import { runMigrations } from "draft-core/migrations/runner";
import { capture } from "./exec";
import { spawnHeadlessAgent } from "draft-core/agents/headless";
import { buildHeadlessSetupPrompt } from "draft-core/agents/prompts/setup";
import { registerGranolaMCP, writeGranolaConfig } from "draft-core/integrations/granola";
import { buildSlackManifestUrl, validateSlackTokenFormat, fetchSlackChannels } from "draft-core/integrations/slack";
import { checkGhCli, connectGitHub as connectGitHubCore } from "draft-core/integrations/github";
import { homedir } from "os";
import {
  listProposals,
  acknowledgeFlaggedProposal,
  acceptProposal as acceptCoreProposal,
  dismissFlaggedProposal,
  proposalArchiveDirs,
  rejectProposal as rejectCoreProposal,
  applyProposalLocally,
} from "draft-core/proposals";
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync, cpSync, mkdirSync, chmodSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { extname, join, resolve } from "path";
import { readLocalConfig, writeLocalConfig } from "draft-core/config";
import {
  getBundledBackgroundDir,
  getBundledDaemonBinPath,
  getBundledPluginDir,
} from "./main/bundlePath";
import { runInstall, syncExtractedBins } from "./main/installer";
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
import { startSkillWatch, stopSkillWatch, restartSkillWatchWithProfile } from "./main/watchers/skills";
import { startMcpWatch, stopMcpWatch, restartMcpWatchWithProfile } from "./main/watchers/mcps";
import {
  detectMcpPending,
  approveMcps as approveMcpsCore,
  setTeamMcpSecret,
} from "draft-core/sync/mcp-sync";
import {
  readMcpManifest,
  writeMcpManifest,
  tombstoneMcp,
} from "draft-core/sync/manifest";
import { readWorkspaceMcpManifest } from "draft-core/sync/workspace-mcp";
import { rebuildEnvSh, switchProfileAssets } from "draft-core/sync/team-assets";
import type { AppRPCType, ContextFileEntry, IntegrationDetail, SlackChannelOption, WorkspaceRun } from "./rpc/schema";
import { startBrowserSignIn } from "./main/auth/browser-sign-in";
import { clearAuthState, getCachedWorkspaceId, readAuthState, writeAuthState } from "draft-core/auth-state";
import { getUserIdentity } from "./main/auth/user-identity";
import { fetchServer, fetchServerJSON } from "./main/server/server-client";

let browserSignInController: AbortController | null = null;

const CONTEXT_SKIP_ROOT = new Set(["log", "accepted", "rejected"]);
const CONTEXT_DIMENSION_ORDER = ["company", "product", "team", "priorities"];

function capitalize(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugToLabel(slug: string): string {
  return capitalize(slug.replace(/[-_]/g, " "));
}

function splitFrontmatter(content: string): { frontmatterRaw: string; body: string } {
  if (!content.startsWith("---")) return { frontmatterRaw: "", body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatterRaw: "", body: content };
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatterRaw: content.slice(0, content.length - body.length), body };
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

function toContextFileEntry(relativePath: string, content: string): ContextFileEntry | null {
  const segments = relativePath.split("/");
  const [group, second, third] = segments;
  if (!group || CONTEXT_SKIP_ROOT.has(group) || !relativePath.endsWith(".md")) return null;

  const split = splitFrontmatter(content);
  if (segments.length === 1) {
    const base = relativePath.replace(/\.md$/, "");
    return {
      relativePath,
      label: slugToLabel(base),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "standalone",
      group: base,
      groupLabel: slugToLabel(base),
    };
  }

  if (segments.length === 2 && second === "index.md") {
    return {
      relativePath,
      label: slugToLabel(group),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "dim",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  if (segments.length === 3 && second === "log" && third) {
    return {
      relativePath,
      label: logEntryLabel(third),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "log",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  if (segments.length === 2 && second) {
    const base = second.replace(/\.md$/, "");
    return {
      relativePath,
      label: slugToLabel(base),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "group-child",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  return null;
}

function sortContextFileEntries(entries: ContextFileEntry[]): ContextFileEntry[] {
  return entries.sort((a, b) => {
    function sortKey(e: ContextFileEntry): [number, number, string, string] {
      const stdIdx = CONTEXT_DIMENSION_ORDER.indexOf(e.group);
      if (e.kind === "dim") {
        return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 0, e.group, ""];
      }
      if (e.kind === "log") {
        return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 1, e.group, e.relativePath];
      }
      if (e.kind === "standalone") return [200, 0, e.group, ""];
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
}

// Keys baked in at build time via electrobun.config.ts define → process.env.
// Falls back to empty string for OSS builds (no build-config.json).
const _phKey          = process.env.DRAFT_PH_KEY           ?? "";
const _phHost         = process.env.DRAFT_PH_HOST          ?? "https://us.i.posthog.com";
// Mirrors backend's PILOT_RUN_BUNDLE_LIMITS (backend/src/synthesis/load-run-bundle.ts) —
// client-side filtering is a UX nicety; the server re-validates these limits itself.
const UPLOAD_MAX_FILE_BYTES = 1_000_000;
const UPLOAD_MAX_TOTAL_BYTES = 10_000_000;
const UPLOAD_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".mp3", ".mp4", ".mov", ".wav", ".avi",
  ".woff", ".woff2", ".ttf", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
]);

// Walks directory-by-directory, pruning ignored directory names (.git,
// node_modules, dotfiles) BEFORE descending into them
async function collectUploadFiles(rootDir: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  let totalBytes = 0;

  function walk(dir: string, relativeDir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (UPLOAD_BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

      const stat = statSync(fullPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.size > UPLOAD_MAX_FILE_BYTES || totalBytes + stat.size > UPLOAD_MAX_TOTAL_BYTES) continue;

      pending.push({ relativePath, fullPath, bytes: stat.size });
      totalBytes += stat.size;
    }
  }

  const pending: { relativePath: string; fullPath: string; bytes: number }[] = [];
  walk(rootDir, "");

  for (const item of pending) {
    try {
      const content = await Bun.file(item.fullPath).text();
      files.push({ path: item.relativePath, content });
    } catch {
      // Not valid UTF-8 text (likely a binary file the extension filter missed) — skip it.
    }
  }

  return files;
}

const _crispWebsiteId      = process.env.DRAFT_CRISP_WEBSITE_ID       ?? "";
const _crispHistoryUrl     = process.env.DRAFT_CRISP_HISTORY_ENDPOINT  ?? "";
const _crispHistorySecret  = process.env.DRAFT_CRISP_HISTORY_SECRET    ?? "";
const _calUrl              = process.env.DRAFT_CAL_URL                 ?? "";

// Migrations must complete before RPC handlers or watchers can write profile state.
// On failure, abort startup and preserve the recoverable pre-migration files.
await runMigrations();

// ── Runner detection ──────────────────────────────────────────────────────────
//
// macOS GUI apps get a stripped PATH. We cannot use `which` or shell resolution
// reliably — ~/.local/bin and nvm paths are typically set in .zshrc (interactive
// shells only), not .zprofile (login shells). Instead we check known installation
// paths directly with existsSync, which works regardless of shell configuration.

async function findRunnerBin(name: string): Promise<string | null> {
  const HOME = process.env.HOME ?? "";

  // Check known installation paths — no PATH or subprocess needed.
  const knownPaths = [
    `${HOME}/.local/bin/${name}`,          // official Claude Code installer default
    `/usr/local/bin/${name}`,              // npm global with default prefix
    `/opt/homebrew/bin/${name}`,           // Homebrew-managed
    `${HOME}/.npm-global/bin/${name}`,     // custom npm prefix
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: nvm — scan installed node versions for the binary.
  const nvmDir = `${HOME}/.nvm/versions/node`;
  if (existsSync(nvmDir)) {
    try {
      const versions = (await import("fs")).readdirSync(nvmDir);
      for (const v of versions.reverse()) { // newest first
        const p = `${nvmDir}/${v}/bin/${name}`;
        if (existsSync(p)) return p;
      }
    } catch {}
  }

  return null;
}

// ── Application menu ───────────────────────────────────────────────────────────

function setAppMenu(daemonRunning: boolean) {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [
        { label: "Check for Updates", action: "check-for-updates" },
        { type: "separator" },
        daemonRunning
          ? { label: "Stop Draft",  action: "stop-draft"  }
          : { label: "Start Draft", action: "start-draft" },
        { type: "separator" },
        { label: "Quit Draft",       action: "quit-app",        accelerator: "q" },
        { label: "Quit Completely",  action: "quit-completely"                   },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
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

  if (action === "check-for-updates") {
    try { rpc.send.updateCheckStarted({}); } catch {}
    void checkAndDownloadUpdate(false);
  }

  if (action === "stop-draft") {
    capture(["launchctl", "bootout", `gui/${process.getuid!()}/${PLIST_LABEL}`])
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
    win.hide();
  }

  if (action === "quit-completely") {
    stopHeartbeatWatch();
    stopProposalWatch();
    stopActiveProfileWatch();
    stopSkillWatch();
    process.exit(0);
  }
});

Electrobun.events.on("reopen", () => {
  try { win.show(); } catch (err) { console.error("[draft-desktop] reopen failed:", err); }
});

// ── Tray ───────────────────────────────────────────────────────────────────────
// TODO: Replace with image asset before Phase 1 ship (put image in "views://assets/tray-icon-template.png")

const tray = new Tray({ title: "Draft" });

function setTrayMenu(daemonRunning: boolean) {
  tray.setMenu([
    { type: "normal",  label: "Open Draft",                                   action: "open"        },
    { type: "divider"                                                                                 },
    daemonRunning
      ? { type: "normal", label: "Stop Draft",  action: "tray-stop-draft"  }
      : { type: "normal", label: "Start Draft", action: "tray-start-draft" },
    { type: "divider"                                                                                 },
    { type: "normal",  label: "Quit Completely",                              action: "quit"        },
  ]);
}

async function refreshTrayMenu() {
  try {
    const s = await getDaemonStatus();
    setTrayMenu(s.state === "running");
  } catch { /* non-fatal */ }
}

// Render with default state immediately; startup check corrects it.
setTrayMenu(true);

// ── RPC ────────────────────────────────────────────────────────────────────────
// watcherHandlers is forward-declared here so switchProfile can reference it.
// It is assigned immediately after rpc is constructed — before any handler fires.

// eslint-disable-next-line prefer-const
let watcherHandlers!: ProposalWatchHandlers;

const rpc = BrowserView.defineRPC<AppRPCType>({
  // Team staging can spend up to 60s cloning; promotion can then wait up to
  // 30s for the profile lock before applying assets. Keep the RPC alive for
  // the full shared-loader lifecycle so the renderer never sees a false timeout.
  maxRequestTime: 120_000,
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
          openclaw:      toolList.includes("openclaw"),
          hermes:        toolList.includes("hermes"),
        };

        return { ...daemonStatus, profile, lastSync, appState, integrations, installedTools };
      },

      getProposals: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        return listProposals(workspace).map((proposal) => ({
          filename: proposal.filename,
          kind: proposal.kind,
          outcome: proposal.outcome,
          needsInputReason: proposal.needsInputReason,
          source: proposal.source,
          dimension: proposal.dimension,
          action: proposal.action,
          timestamp: proposal.timestamp,
          summary: proposal.summary,
          createdAt: proposal.createdAt,
          body: proposal.body,
          currentContent: readContextFile(workspace, proposal.dimension),
          rawContent: proposal.rawContent,
          content: proposal.content,
        }));
      },

      getProfiles: async () => getProfiles(),

      switchProfile: async ({ profile }) => {
        const oldProfile = getActiveProfile();
        try {
          const result = await switchProfileAssets(oldProfile, profile);
          const newWorkspacePath = getWorkspacePath(profile);
          const wsManifest = readWorkspaceMcpManifest(newWorkspacePath);
          if (result.missingSecrets.length > 0) {
            try {
              rpc.send.mcpsPendingCredentials({
                mcps: result.missingSecrets.map(({ name, requiredSecrets }) => {
                  const entry = wsManifest.servers.find((server) => server.name === name);
                  return { name, url: entry?.canonical.url ?? "", required_secrets: requiredSecrets };
                }),
              });
            } catch {}
          }

          restartProposalWatch(profile, watcherHandlers);
          restartSkillWatchWithProfile(profile);
          restartMcpWatchWithProfile(profile);

          try { rpc.send.profileChanged({ profile }); } catch {}
          return { ok: true, active: profile };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      createProfile: async ({ name }) => {
        const created = createProfile(name);
        if (!created.ok) {
          return { ok: false, error: created.reason === "exists" ? `Workspace "${name}" already exists.` : `Invalid name. Use letters, numbers, hyphens, and underscores only.` };
        }
        const oldProfile = getActiveProfile();
        // switchProfileAssets owns activation atomically, inside the
        // profile-switch lock, with its own rollback-on-failure path — don't
        // call setActiveProfile manually first, which would leave the
        // active-profile file pointing at the new profile before the old
        // profile's assets are torn down and before any lock is held. There
        // is only ever one active profile, so creating (and implicitly
        // activating) a new one also deactivates the outgoing profile's
        // personal skill symlinks — the active profile's approved personal
        // skills are the only ones currently mirrored to the sibling agent.
        // A new workspace has no team assets, so this is a fast no-op for
        // the install side, but it still uninstalls the old profile's
        // team/personal assets and writes env.sh. A failure here means the
        // new profile isn't safely usable yet — surface it, don't swallow it.
        try {
          await switchProfileAssets(oldProfile, created.name);
        } catch (error) {
          return { ok: false, error: `Created workspace but could not activate it: ${error instanceof Error ? error.message : String(error)}` };
        }
        restartProposalWatch(created.name, watcherHandlers);
        restartSkillWatchWithProfile(created.name);
        restartMcpWatchWithProfile(created.name);
        try { rpc.send.profileChanged({ profile: created.name }); } catch {}
        return { ok: true, active: created.name };
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
        const result = await capture(["launchctl", "bootout", `gui/${process.getuid!()}/${PLIST_LABEL}`]);
        refreshAppMenu().catch(() => {});
        return { ok: result.exitCode === 0, error: result.stderr || undefined };
      },

      acceptProposal: async ({ filename }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const proposal = listProposals(workspace).find((item) => item.filename === filename);
          if (!proposal) return { ok: false, error: "Proposal not found" };
          if (proposal.kind === "flagged") {
            acknowledgeFlaggedProposal(proposal, workspace);
          } else {
            // Manual/import proposals keep their existing apply-on-accept behavior.
            applyProposalLocally(proposal, workspace);
            acceptCoreProposal(proposal, proposalArchiveDirs(workspace).accepted);
          }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Accept failed" };
        }
      },

      rejectProposal: async ({ filename }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const proposal = listProposals(workspace).find((item) => item.filename === filename);
          if (!proposal) return { ok: false, error: "Proposal not found" };
          if (proposal.kind === "flagged") {
            dismissFlaggedProposal(proposal, workspace);
          } else {
            rejectCoreProposal(proposal, proposalArchiveDirs(workspace).rejected);
          }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Reject failed" };
        }
      },

      getLocalConfig: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const result = readLocalConfig(workspace);
        const c = result.ok ? result.config : {};
        return {
          launchOnLogin:             c.launchOnLogin             ?? false,
          notificationsEnabled:      c.notificationsEnabled      ?? true,
          disabledContextSections:   c.disabledContextSections   ?? [],
          codexScanIntervalMinutes:  c.codexScanIntervalMinutes  ?? 360,
          claudeCodeSynthesis:       c.claudeCodeSynthesis       ?? true,
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
        try {
          // Currently assumes one team_default workspace. A real workspace list and
          // picker are needed before supporting teams with multiple workspaces.
          const workspaceId = getCachedWorkspaceId();
          if (!workspaceId) return [];

          // This RPC always reads the current cloud snapshot. The renderer owns
          // the session-lifetime snapshot used to survive Context tab remounts;
          // a persistent local cache/mirror remains deferred.
          const context = await fetchServerJSON<{
            documents: Record<string, { content: string; sha256: string }>;
          }>(`workspaces/${workspaceId}/context`);

          return sortContextFileEntries(
            Object.entries(context.documents).flatMap(([path, document]) => {
              const entry = toContextFileEntry(path, document.content);
              return entry ? [entry] : [];
            }),
          );
        } catch {
          return [];
        }
      },

      getConnectedApps: async () => {
        // Tools — read from global config.json (not per-profile)
        const cfgResult = readDraftConfig();
        const toolsCfg  = cfgResult.ok ? cfgResult.config.tools : {};

        function toolDetail(key: "claude-code" | "codex" | "cursor" | "openclaw" | "hermes") {
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
        type CloudConnectionStatus = {
          provider: "slack" | "fireflies" | "linear" | "claude_code";
          status: string | null;
          last_success_at: string | null;
          last_error_at: string | null;
          channel_ids?: string[];
          connected?: boolean;
        };
        let cloudConnections: CloudConnectionStatus[] | null = null;
        const cloudWorkspaceId = getCachedWorkspaceId();
        if (cloudWorkspaceId) {
          try {
            const response = await fetchServerJSON<{ connections: CloudConnectionStatus[] }>(
              `workspaces/${cloudWorkspaceId}/connections`,
            );
            cloudConnections = response.connections;
          } catch {
            cloudConnections = null;
          }
        }

        function integrationHealth(key: "granola" | "fireflies"): Pick<IntegrationDetail, "healthStatus" | "healthCheckedAt" | "healthMessage"> {
          try {
            const raw = JSON.parse(readFileSync(join(BACKGROUND_DIR, "state", `${key}.json`), "utf8")) as {
              health?: { status?: unknown; checked_at?: unknown; message?: unknown };
            };
            const status = raw.health?.status;
            return {
              healthStatus: status === "healthy" ? "healthy" : status === "unavailable" ? "needs_attention" : "unknown",
              healthCheckedAt: typeof raw.health?.checked_at === "string" ? raw.health.checked_at : null,
              healthMessage: typeof raw.health?.message === "string" ? raw.health.message : null,
            };
          } catch {
            return { healthStatus: "unknown", healthCheckedAt: null, healthMessage: null };
          }
        }

        function integrationDetail(key: "granola" | "slack" | "github" | "fireflies" | "linear"): IntegrationDetail {
          const entry = key === "linear" ? undefined : int[key];
          const cloud = (key === "slack" || key === "fireflies" || key === "linear")
            ? cloudConnections?.find((connection) => connection.provider === key)
            : undefined;
          const health = key === "granola" || key === "fireflies"
            ? integrationHealth(key)
            : { healthStatus: "unknown" as const, healthCheckedAt: null, healthMessage: null };
          if (key === "slack" || key === "fireflies" || key === "linear") {
            return {
              // Cloud-backed integrations must not fall back to stale local flags
              // when the server is unreachable or the user is signed out.
              connected: cloud?.status === "active",
              healthStatus: cloud?.status === "active" ? "healthy" : cloud?.status === "degraded" || cloud?.status === "error" ? "needs_attention" : "unknown",
              healthCheckedAt: cloud?.last_success_at ?? null,
              healthMessage: cloud?.last_error_at ? "The cloud ingestion worker reported an error." : null,
              lastConnected: cloud?.last_success_at ?? null,
              mode: null,
              channels: key === "slack" ? (cloud?.channel_ids?.length ?? 0) : null,
              channelIds: key === "slack" ? (cloud?.channel_ids ?? []) : undefined,
              repos: [],
              ghCliStatus: null,
            };
          }
          return {
            connected:     entry?.connected    ?? false,
            ...health,
            lastConnected: entry?.last_connected ?? null,
            mode:          entry?.mode          ?? null,
            channels:      entry?.channels      ?? null,
            channelIds:    undefined,
            repos:         entry?.repos         ?? [],
            ghCliStatus:    null,
          };
        }

        const githubDetail = integrationDetail("github");
        githubDetail.ghCliStatus = githubDetail.connected
          ? await checkGhCli()
          : null;

        const claudeCodeConnection = cloudConnections?.find((connection) => connection.provider === "claude_code");

        return {
          tools: {
            "claude-code": toolDetail("claude-code"),
            codex:         toolDetail("codex"),
            cursor:        toolDetail("cursor"),
            openclaw:      toolDetail("openclaw"),
            hermes:        toolDetail("hermes"),
          },
          integrations: {
            granola:   integrationDetail("granola"),
            slack:     integrationDetail("slack"),
            github:    githubDetail,
            fireflies: integrationDetail("fireflies"),
            linear:    integrationDetail("linear"),
          },
          claudeCode: { connected: claudeCodeConnection?.status === "active" },
        };
      },

      disconnectIntegration: async ({ source }) => {
        try {
          if (source === "slack" || source === "fireflies" || source === "linear") {
            const workspaceId = getCachedWorkspaceId();
            if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
            await fetchServer(`workspaces/${workspaceId}/connections/${source}`, { method: "DELETE" });
            return { ok: true };
          }
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
        const workspace = getWorkspacePath(getActiveProfile());
        // Renderer polls getConnectedApps until github.connected === true.
        return connectGitHubCore({ workspace });
      },

      getSessionPreview: async () => {
        const scriptPath = `${process.env.HOME}/.draft/shared/hooks/inject-context.sh`;
        if (!existsSync(scriptPath)) {
          return { text: "", tokenEstimate: 0 };
        }
        try {
          const proc = Bun.spawn(["bash", scriptPath], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            env: { ...process.env } as Record<string, string>,
          });
          const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
          await proc.exited;
          return { text, tokenEstimate: Math.ceil(text.length / 4) };
        } catch {
          return { text: "", tokenEstimate: 0 };
        }
      },

      getContextSections: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const contextDir = join(workspace, "context");
        const sections: import("./rpc/schema").ContextSection[] = [];

        function capitalize(s: string): string {
          return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        }

        if (existsSync(contextDir)) {
          let names: string[];
          try { names = readdirSync(contextDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(join(contextDir, e.name, "index.md")))
            .map((e) => e.name)
            .sort();
          } catch { names = []; }

          for (const name of names) {
            sections.push({
              name,
              label: capitalize(name),
              injectionMode: name === "priorities" ? "full" : "summary",
            });
          }
        }

        // Memory is a fixed global section
        const memoryPath = join(process.env.HOME ?? "", ".draft", "personal", "memory.md");
        if (existsSync(memoryPath)) {
          sections.push({ name: "memory", label: "Memory", injectionMode: "full" });
        }

        return sections;
      },

      revealInFinder: async ({ relativePath }: { relativePath: string }) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const absPath = join(workspace, "context", relativePath);
          if (!existsSync(absPath)) {
            return { ok: false, error: "File not found." };
          }
          Bun.spawn(["open", "-R", absPath], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Failed to reveal in Finder." };
        }
      },

      runInstall: async ({ tools }) => {
        console.log(`[rpc] runInstall called — tools: ${JSON.stringify(tools)}`);
        const result = await runInstall(tools);
        console.log(`[rpc] runInstall returned — ok: ${result.ok}, steps: ${result.steps.length}`);
        return result;
      },

      scanSkills: async () => {
        const { skills, errors } = scanSkillDirectories();
        const mcpServers = scanMCPConnections();
        const manifest = readSkillManifest();
        return {
          skills: skills.map(({ name, agent, dirPath, description, descriptionTokenCount, tokenCount }) => {
            const entry = manifest.skills[`${agent}:${name}`];
            const synced = entry?.status === "approved" && Object.keys(entry.synced_to ?? {}).length > 0;
            return { name, agent, dirPath, description, descriptionTokenCount, tokenCount, synced };
          }),
          scanErrors: errors,
          mcpServers: mcpServers.map(({ name, agent, config }) => ({ name, agent, config })),
        };
      },

      importSkills: async ({ skills }) => {
        const { skills: available } = scanSkillDirectories();
        const selected = skills.flatMap((requested) => {
          const match = available.find((skill) =>
            skill.name === requested.name
            && skill.agent === requested.agent
            && skill.dirPath === requested.dirPath,
          );
          return match ? [match] : [];
        });
        const result = createSymlinks(selected);
        return {
          ok: result.errors.length === 0,
          created: result.created.length,
          skipped: result.skipped.length,
          ...(result.errors.length > 0 ? { error: result.errors.join("\n") } : {}),
        };
      },

      removeSkills: async ({ skills }) => {
        const { skills: available } = scanSkillDirectories();
        const selected = skills.flatMap((requested) => {
          const match = available.find((skill) =>
            skill.name === requested.name
            && skill.agent === requested.agent
            && skill.dirPath === requested.dirPath,
          );
          return match ? [match] : [];
        });
        const result = removeSymlinks(selected);
        return {
          ok: result.errors.length === 0,
          removed: result.removed.length,
          ...(result.errors.length > 0 ? { error: result.errors.join("\n") } : {}),
        };
      },

      startSkillWatcher: async () => {
        const profile = getActiveProfile();
        startSkillWatch({
          onSkillsPending: (pending) => {
            try { rpc.send.skillsPendingApproval({ pending }); } catch {}
          },
          onSkillsConflict: (conflicts) => {
            try { rpc.send.skillsConflict({ conflicts }); } catch {}
          },
          onSkillsChanged: (count) => {
            try { rpc.send.skillsChanged({ count }); } catch {}
          },
          onReconciled: (_result) => {},
        }, { activeProfile: profile });
      },

      getSkillsPending: async () => {
        return detectPending();
      },

      approveSkills: async ({ skills }) => {
        const scannedSkills = skills.map((p: PendingSkillEntry) => ({
          name: p.name,
          agent: p.source_agent,
          dirPath: p.source_path,
          files: [],
          description: p.description,
          descriptionTokenCount: 0,
          tokenCount: p.tokenCount,
        }));
        const result = createSymlinks(scannedSkills);
        return {
          ok: result.errors.length === 0,
          created: result.created.length,
          ...(result.errors.length > 0 ? { error: result.errors.join("\n") } : {}),
        };
      },

      resolveSkillConflict: async ({ conflict, resolution }: { conflict: SameNameConflict; resolution: { action: string; authoritative_agent?: string } }) => {
        if (resolution.action === "keep-local") {
          // Mark both entries in the manifest as conflict/skipped — no symlinks
          try {
            const manifest = readSkillManifest();
            const now = new Date().toISOString();
            // Record the conflict as resolved with no sync
            manifest.name_conflicts[conflict.name] = {
              agents: ["claude-code", "codex"],
              resolved: true,
              authoritative_agent: null,
            };
            writeSkillManifest(manifest);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : "Could not update manifest." };
          }
        }

        if (resolution.action === "use-source" && resolution.authoritative_agent) {
          const authAgent = resolution.authoritative_agent as "claude-code" | "codex";
          const sourcePath = conflict[authAgent].path;
          const targetAgent: "claude-code" | "codex" = authAgent === "claude-code" ? "codex" : "claude-code";

          const skill = {
            name: conflict.name,
            agent: authAgent,
            dirPath: sourcePath,
            files: [],
            description: "",
            descriptionTokenCount: 0,
            tokenCount: 0,
          };

          const result = createSymlinks([skill]);
          if (result.errors.length > 0) {
            return { ok: false, error: result.errors.join("\n") };
          }
          if (result.conflicts.length > 0) {
            return {
              ok: false,
              error: `Cannot sync: a different entry already exists at the target. Rename or remove ~/.${targetAgent === "codex" ? "codex" : "claude"}/skills/${conflict.name} first.`,
            };
          }
          return { ok: true };
        }

        return { ok: false, error: "Unknown resolution action." };
      },

      getMcpPending: async () => {
        return detectMcpPending();
      },

      approveMcps: async ({ mcps }) => {
        try {
          const result = await approveMcpsCore(mcps);
          if (result.errors.length > 0 || result.conflicts.length > 0) {
            const parts = [
              ...result.errors,
              ...result.conflicts.map((c) => `${c.name}: ${c.reason}`),
            ];
            return { ok: false, error: parts.join("; ") };
          }
          // A newly-approved Codex-bound personal MCP's secret must be
          // sourceable immediately, not only after the next profile switch.
          try { rebuildEnvSh(getActiveProfile()); } catch { /* non-fatal */ }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Failed to approve MCPs." };
        }
      },

      resolveMcpConflict: async ({ name, authoritative_agent }) => {
        try {
          const manifest = readMcpManifest();
          manifest.name_conflicts[name] = {
            agents: ["claude-code", "codex"],
            resolved: true,
            authoritative_agent,
          };
          writeMcpManifest(manifest);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve conflict." };
        }
      },

      removeMcp: async ({ id }) => {
        try {
          tombstoneMcp(id);
          // Reconcile will handle removing from target configs on next watcher cycle
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Failed to remove MCP." };
        }
      },

      getMcpManifest: async () => {
        return readMcpManifest();
      },

      connectGranolaMCP: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const reg = await registerGranolaMCP(workspace);
        if (!reg.ok) return reg;
        try {
          writeGranolaConfig(workspace, "mcp", undefined, reg.mcpServerId);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not save the Granola connection." };
        }
      },

      connectGranolaAPI: async ({ apiKey }) => {
        if (!apiKey.trim()) return { ok: false, error: "Enter your Granola API key." };
        try {
          writeGranolaConfig(getWorkspacePath(getActiveProfile()), "api", apiKey.trim());
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not save the Granola connection." };
        }
      },

      connectFireflies: async ({ apiKey }) => {
        if (!apiKey.trim()) return { ok: false, error: "Enter your Fireflies API key." };
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true; webhookUrl: string; webhookSecret: string }>(`workspaces/${workspaceId}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "fireflies", api_token: apiKey.trim() }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not connect Fireflies." };
        }
      },

      connectLinear: async ({ apiKey }) => {
        if (!apiKey.trim()) return { ok: false, error: "Enter your Linear API key." };
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true }>(`workspaces/${workspaceId}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "linear", api_token: apiKey.trim() }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not connect Linear." };
        }
      },

      connectClaudeCode: async ({ token }) => {
        if (!token.trim()) return { ok: false, error: "Paste your Claude Code OAuth token." };
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true }>(`workspaces/${workspaceId}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "claude_code", token: token.trim() }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not connect Claude Code." };
        }
      },

      getInviteLink: async () => {
        try {
          const response = await fetchServerJSON<{ url: string; expiresAt: string }>("invites/mine");
          return { ok: true as const, ...response };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not load the invite link." };
        }
      },

      getSlackManifestUrl: async () => buildSlackManifestUrl(),

      listSlackChannels: async ({ botToken }) => {
        if (botToken) {
          // Initial channel selection is public-only. Private channels are not
          // discoverable until the bot has been invited to them in Slack.
          const result = await fetchSlackChannels(botToken, "public_channel");
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, channels: result.channels.map((channel) => ({ ...channel, allowlisted: false })) };
        }

        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true; channels: SlackChannelOption[] }>(
            `workspaces/${workspaceId}/connections/slack/channels`,
          );
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not load Slack channels." };
        }
      },

      connectSlack: async ({ botToken, appToken, channelIds }) => {
        const fmt = validateSlackTokenFormat(botToken, appToken);
        if (!fmt.ok) return fmt;
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true }>(`workspaces/${workspaceId}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "slack", bot_token: botToken, app_token: appToken, channel_ids: channelIds }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not connect Slack." };
        }
      },

      updateSlackChannels: async ({ channelIds }) => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true }>(`workspaces/${workspaceId}/connections/slack`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel_ids: channelIds }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not update Slack channels." };
        }
      },

      selectSetupFolder: async () => {
        try {
          const [folderPath] = await Utils.openFileDialog({
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          return { folderPath: folderPath || null };
        } catch {
          return { folderPath: null };
        }
      },

      selectUploadFolder: async () => {
        try {
          const [folderPath] = await Utils.openFileDialog({
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          return { folderPath: folderPath || null };
        } catch {
          return { folderPath: null };
        }
      },

      uploadSourceItems: async ({ folderPath, triggerSynthesis }) => {
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return { ok: false, error: "Choose a valid local folder to upload." };
        }
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };

        let files: { path: string; content: string }[];
        try {
          files = await collectUploadFiles(folderPath);
        } catch (err) {
          console.error("uploadSourceItems: failed to walk selected folder", folderPath, err);
          return { ok: false, error: err instanceof Error ? `Could not read the selected folder: ${err.message}` : "Could not read the selected folder." };
        }

        if (files.length === 0) {
          return { ok: false, error: "No eligible files found in that folder." };
        }

        try {
          return await fetchServerJSON<{
            ok: true; inserted: number; skipped: string[];
            runId?: string; machineId?: string; reason?: string; synthesisError?: string;
          }>(
            `workspaces/${workspaceId}/source-items`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ files, triggerSynthesis }),
            },
          );
        } catch (err) {
          console.error("uploadSourceItems: POST /source-items failed", err);
          return { ok: false, error: err instanceof Error ? err.message : "Could not upload files." };
        }
      },

      bootstrapWorkspaceContext: async ({ folderPath, dimensions }) => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };

        if (folderPath) {
          if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
            return { ok: false, error: "Choose a valid local folder to upload." };
          }
          let files: { path: string; content: string }[];
          try {
            files = await collectUploadFiles(folderPath);
          } catch (err) {
            console.error("bootstrapWorkspaceContext: failed to walk selected folder", folderPath, err);
            return { ok: false, error: err instanceof Error ? `Could not read the selected folder: ${err.message}` : "Could not read the selected folder." };
          }
          if (files.length === 0) {
            return { ok: false, error: "No eligible files found in that folder." };
          }
          try {
            return await fetchServerJSON<{
              ok: true; inserted: number; skipped: string[];
              runId?: string; machineId?: string; reason?: string; synthesisError?: string;
            }>(
              `workspaces/${workspaceId}/source-items`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ files, triggerSynthesis: true, dimensions }),
              },
            );
          } catch (err) {
            console.error("bootstrapWorkspaceContext: POST /source-items failed", err);
            return { ok: false, error: err instanceof Error ? err.message : "Could not upload files." };
          }
        }

        try {
          return await fetchServerJSON<{ ok: boolean; runId?: string; machineId?: string; reason?: string; error?: string }>(
            `workspaces/${workspaceId}/synthesis-runs`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dimensions }),
            },
          );
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not start the workspace synthesis run." };
        }
      },

      getAvailableRunners: async () => {
        const [claudePath, codexPath] = await Promise.all([
          findRunnerBin("claude"),
          findRunnerBin("codex"),
        ]);
        return {
          runners: [
            { name: "claude" as const, installed: claudePath !== null },
            { name: "codex" as const, installed: codexPath !== null },
          ],
        };
      },

      getWorkspaceContextStatus: async () => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { hasContext: false };
        try {
          await fetchServerJSON(`workspaces/${workspaceId}/context`);
          return { hasContext: true };
        } catch {
          // Covers both the expected "no_context_yet" 404 and any other failure
          return { hasContext: false };
        }
      },

      triggerSynthesisRun: async () => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: boolean; runId?: string; machineId?: string; reason?: string; error?: string }>(
            `workspaces/${workspaceId}/synthesis-runs`,
            { method: "POST" },
          );
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not start the workspace synthesis run." };
        }
      },

      runHeadlessSetup: async ({ mode, folderPath, githubUrl, runner, dimensions }) => {
        const workspace = getWorkspacePath(getActiveProfile());

        let importSummary: string | undefined;
        if (mode === "import") {
          if (!folderPath || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
            return { ok: false, error: "Choose a valid local folder to import." };
          }
          try {
            const entries = readdirSync(folderPath, { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .slice(0, 100)
              .map((entry) => entry.name);
            importSummary = `Local folder: ${folderPath}\nFiles (first ${entries.length}):\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
          } catch {
            return { ok: false, error: "Could not read the selected folder." };
          }
        } else if (mode === "github") {
          if (!githubUrl?.trim()) return { ok: false, error: "Paste a GitHub repository URL." };
          if (!githubUrl.trim().match(/github\.com\/([^/]+\/[^/]+)/)) {
            return { ok: false, error: "Enter a valid GitHub URL (e.g. https://github.com/owner/repo)." };
          }
          importSummary = `GitHub repository: ${githubUrl.trim()}\nClone this repo into a temp directory, read its README and top-level structure, and use that as context for the workspace. Use \`gh repo clone\` first (handles private repos via authenticated GitHub CLI). If gh is not installed or fails, fall back to \`git clone --depth 1\`. Delete the temp clone when done.`;
        }

        const integrations = readIntegrations(workspace);
        const connectedIntegrations = integrations.ok
          ? Object.entries(integrations.integrations)
              .filter(([, entry]) => entry.connected)
              .map(([name]) => name)
          : [];

        const prompt = buildHeadlessSetupPrompt({
          workspace,
          installedTools: getInstalledTools(),
          connectedIntegrations,
          importSummary,
          dimensions,
        });

        return spawnHeadlessAgent({
          runner: runner ?? "claude",
          prompt,
          onProgress: (p) => { try { rpc.send.headlessProgress(p); } catch {} },
        });
      },

      applyUpdate: async () => {
        try {
          if (!Electrobun.Updater.updateInfo()?.updateReady) {
            return { ok: false, error: "No update is staged." };
          }
          await Electrobun.Updater.applyUpdate();
          return { ok: true }; // unreachable — app restarts
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Apply failed." };
        }
      },

      getAppVersion: async () => {
        try {
          const info = await Electrobun.Updater.getLocalInfo();
          return { version: info.version, channel: info.channel };
        } catch {
          return { version: "dev", channel: "dev" };
        }
      },

      getCrispConfig: async () => {
        return {
          website_id:       _crispWebsiteId,
          cal_url:          _calUrl,
          history_endpoint: _crispHistoryUrl,
          history_secret:   _crispHistorySecret,
        };
      },

      getAnalyticsConfig: async () => {
        const result = readDraftConfig();
        const config: import("draft-core/config").DraftConfig = result.ok ? result.config : { version: "1", tools: {} };
        const analytics = ensureAnalyticsConfig(config);
        // Persist only if anonymous_id was just generated (first launch).
        if (!config.analytics?.anonymous_id) {
          writeDraftConfig({ ...config, analytics });
        }
        // posthog_key and api_host baked in at build time — never written to config.json.
        // posthog_host from config.json takes precedence (allows per-user override).
        return {
          ...analytics,
          posthog_key:  _phKey,
          posthog_host: analytics.posthog_host ?? _phHost,
        };
      },

      setAnalyticsConfig: async (patch: Partial<AnalyticsConfig>) => {
        try {
          const result = readDraftConfig();
          const config = result.ok ? result.config : { version: "1", tools: {} };
          const current = ensureAnalyticsConfig(config);
          writeDraftConfig({ ...config, analytics: { ...current, ...patch } });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Write failed." };
        }
      },

      getWorkspaceRuns: async () => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return [];
        try {
          const response = await fetchServerJSON<{ runs: WorkspaceRun[] }>(`workspaces/${workspaceId}/synthesis-runs`);
          return response.runs;
        } catch {
          return [];
        }
      },

      setMcpSecret: async ({ name, envVar, value }) => {
        const profile = getActiveProfile();
        // Team-MCP secrets are profile-scoped (same path resolvePaths uses in
        // team-assets.ts) — without this the secret lands in the global
        // secrets.json and the next profile switch, which reads the
        // profile-scoped file, would flip the MCP back to pending-secrets.
        const result = await setTeamMcpSecret(name, profile, envVar, value, {
          statePath: join(getWorkspacePath(profile), "config"),
        });
        if (!result.ok) return { ok: false, error: result.error, nowInstalled: false };
        if (result.nowInstalled) {
          try { rebuildEnvSh(profile); } catch { /* non-fatal */ }
        }
        return { ok: true, nowInstalled: result.nowInstalled };
      },

      startBrowserSignIn: async () => {
        browserSignInController?.abort();
        browserSignInController = new AbortController();
        void startBrowserSignIn(browserSignInController.signal, {
          openUrl: (url) =>
            Bun.spawn(["open", url], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          progress: (value) => {
            try {
              rpc.send.signInProgress(value);
            } catch {}
          },
        });
        return { ok: true };
      },
      cancelBrowserSignIn: async () => {
        browserSignInController?.abort();
        browserSignInController = null;
        return { ok: true };
      },
      signOut: async () => {
        browserSignInController?.abort();
        browserSignInController = null;
        try {
          clearAuthState();
        } catch {
          return { ok: false, error: "Could not sign out" };
        }
        try { rpc.send.authStateChanged({ signedIn: false }); } catch {}
        return { ok: true };
      },
      getUserIdentity: async () => {
        return getUserIdentity();
      },
      completeOnboarding: async () => {
        try {
          const result = await fetchServerJSON<{ onboarding_completed_at: string | null }>(
            "onboarding-complete",
            { method: "POST" },
          );
          const current = readAuthState();
          if (current) writeAuthState({ ...current, onboarding_completed_at: result.onboarding_completed_at });
          try { rpc.send.identityRefreshNeeded({}); } catch {}
          return { ok: true, onboardingCompletedAt: result.onboarding_completed_at };
        } catch (err) {
          console.error("completeOnboarding: POST /onboarding-complete failed", err);
          return { ok: false, error: err instanceof Error ? err.message : "Could not mark onboarding complete." };
        }
      },
    },
    messages: {
      sendNotification: ({ title, subtitle, body }) => {
        Utils.showNotification({ title, subtitle, body });
      },
      openUrl: ({ url }) => {
        Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      },
      openWorkspaceInFinder: () => {
        const workspace = getWorkspacePath(getActiveProfile());
        Bun.spawn(["open", workspace], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      },
      requestUpdateCheck: () => {
        void checkAndDownloadUpdate(false);
      },
    },
  },
});

// ── Daemon binary sync ─────────────────────────────────────────────────────────

function daemonPlistContent(binPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binPath}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.HOME ?? ""}/.draft/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${process.env.HOME ?? ""}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${BACKGROUND_DIR}/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${BACKGROUND_DIR}/logs/daemon-error.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

async function syncBundledAssets(): Promise<void> {
  let appVersion: string;
  let appBuildId: string;
  let isDevChannel: boolean;
  try {
    const info = await Electrobun.Updater.getLocalInfo();
    appVersion = info.version;
    // Two builds can share a version string (e.g. a same-version dev rebuild, or
    // a hotfix cut without a version bump). `hash` is Electrobun's per-build
    // content hash for canary/stable builds, so combining it with version
    // closes that gap there — an earlier same-version build's stamp no longer
    // permanently masks a later one's real fixes.
    appBuildId = `${info.version}:${info.hash}`;
    isDevChannel = info.channel === "dev";
  } catch {
    return;
  }

  // Keep ~/.draft/bin/{draft,bun,tmux} in lockstep with the running build on
  // every launch — self-update replaces the .app bundle but never re-runs the
  // onboarding extraction, so already-onboarded users would otherwise keep
  // stale (possibly broken) binaries forever. Keyed on the same version:hash
  // build id as the daemon runtime below, and likewise runs before every early
  // return so it isn't skipped on no-op launches.
  try {
    await syncExtractedBins(appBuildId, isDevChannel);
  } catch (err) {
    console.warn(`[draft-desktop] bin sync failed: ${err instanceof Error ? err.message : err}`);
  }

  const sidecarPath = `${BACKGROUND_DIR}/.app-version`;
  const installedBuildId = existsSync(sidecarPath)
    ? readFileSync(sidecarPath, "utf8").trim()
    : null;

  // Plist migration: existing users have a plist pointing at the old bash daemon.
  const plistContent = existsSync(PLIST_PATH) ? readFileSync(PLIST_PATH, "utf8") : "";
  const plistNeedsMigration = plistContent.includes("draft-daemon.sh");

  // Electrobun always reports hash="dev" for local dev-channel builds (never
  // packaged into a hashed update artifact), so two different dev builds are
  // otherwise indistinguishable under the version:hash key above — confirmed
  // empirically, hash stayed "dev" across two separate `bun run build:dev`
  // runs. Always resync on dev rather than risk masking a same-version,
  // same-hash rebuild; the resync itself is just a few cheap file copies.
  if (!isDevChannel && installedBuildId === appBuildId && !plistNeedsMigration) return;

  // ── Daemon binary ───────────────────────────────────────────────────────────
  const bundledBin = getBundledDaemonBinPath();
  const installedBin = `${BACKGROUND_DIR}/draft-background-bin`;

  if (bundledBin && existsSync(bundledBin)) {
    try {
      copyFileSync(bundledBin, installedBin);
      chmodSync(installedBin, 0o755);
      console.log(`[draft-desktop] daemon binary updated to ${appVersion}`);
    } catch (err) {
      console.warn(`[draft-desktop] daemon binary sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Daemon runtime scripts ─────────────────────────────────────────────────
  // The compiled daemon delegates session synthesis to shell adapters under
  // ~/.draft/background. Keep that runtime in lockstep with the binary while
  // preserving user-generated queues, state, logs, and Slack captures.
  const backgroundDir = getBundledBackgroundDir();
  const runtimeFiles = [
    "commit-to-team-context.sh",
    "config.sh",
    "install.sh",
    "load-team.sh",
    "on-session-end.sh",
    "start.sh",
    "status.sh",
    "stop.sh",
    "uninstall.sh",
  ];
  const runtimeDirectories = ["intelligence", "integrations", "synthesizers"];

  if (existsSync(backgroundDir)) {
    try {
      for (const relativePath of runtimeFiles) {
        const source = join(backgroundDir, relativePath);
        if (!existsSync(source)) continue;
        copyFileSync(source, join(BACKGROUND_DIR, relativePath));
        if (relativePath.endsWith(".sh")) chmodSync(join(BACKGROUND_DIR, relativePath), 0o755);
      }

      for (const relativeDir of runtimeDirectories) {
        const sourceDir = join(backgroundDir, relativeDir);
        if (!existsSync(sourceDir)) continue;
        mkdirSync(join(BACKGROUND_DIR, relativeDir), { recursive: true });
        for (const entry of readdirSync(sourceDir)) {
          // Capture files are user data, not bundled daemon code.
          if (relativeDir === "integrations" && entry === "slack") {
            const slackSourceDir = join(sourceDir, entry);
            const slackTargetDir = join(BACKGROUND_DIR, relativeDir, entry);
            mkdirSync(slackTargetDir, { recursive: true });
            for (const slackEntry of readdirSync(slackSourceDir)) {
              if (slackEntry === "captures") continue;
              cpSync(join(slackSourceDir, slackEntry), join(slackTargetDir, slackEntry), {
                recursive: true,
                force: true,
              });
            }
            continue;
          }
          cpSync(join(sourceDir, entry), join(BACKGROUND_DIR, relativeDir, entry), {
            recursive: true,
            force: true,
          });
        }
      }

      // The build manifest is an explicit allowlist of bundled JS entrypoints.
      // Remove only their raw-TS predecessors; queues, state, captures, prompts,
      // and any unlisted user files are never cleanup targets.
      const runtimeManifest = join(backgroundDir, ".runtime-bundles");
      if (existsSync(runtimeManifest)) {
        for (const bundledPath of readFileSync(runtimeManifest, "utf8").split(/\r?\n/)) {
          if (!bundledPath || bundledPath.startsWith("/") || bundledPath.includes("\\") || bundledPath.split("/").includes("..")) continue;
          if (!/^(integrations|synthesizers|intelligence)\/[a-zA-Z0-9_./-]+\.js$/.test(bundledPath)) continue;
          const staleTs = join(BACKGROUND_DIR, bundledPath.replace(/\.js$/, ".ts"));
          if (existsSync(staleTs)) unlinkSync(staleTs);
        }
      }
      // Older releases copied the monorepo dependency tree into the installed
      // runtime. Bundles are self-contained now; this exact generated path is
      // the only directory-level stale asset cleanup performed here.
      rmSync(join(BACKGROUND_DIR, "node_modules"), { recursive: true, force: true });
      console.log(`[draft-desktop] daemon runtime synced to ${appVersion}`);
    } catch (err) {
      console.warn(`[draft-desktop] daemon runtime sync failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  // ── Plugin content (skills, agents, hooks) ──────────────────────────────────
  const pluginDir = getBundledPluginDir();
  const populateScript = join(pluginDir, "scripts", "populate-shared.sh");

  if (existsSync(populateScript)) {
    try {
      const result = await capture(["bash", populateScript], {
        env: { PLUGIN_ROOT: pluginDir, USE_LOCAL: "true" },
      });
      if (result.exitCode === 0) {
        console.log(`[draft-desktop] plugin content synced to ${appVersion}`);
      } else {
        console.warn(`[draft-desktop] plugin sync failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[draft-desktop] plugin sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Plist migration ─────────────────────────────────────────────────────────
  if (plistNeedsMigration) {
    try {
      writeFileSync(PLIST_PATH, daemonPlistContent(installedBin), "utf8");
      await capture(["launchctl", "bootout", `gui/${process.getuid!()}/${PLIST_LABEL}`]).catch(() => {});
      await capture(["launchctl", "bootstrap", `gui/${process.getuid!()}`, PLIST_PATH]);
      await capture(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/${PLIST_LABEL}`]);
      console.log("[draft-desktop] daemon plist migrated to draft-background-bin");
    } catch (err) {
      console.warn(`[draft-desktop] daemon plist migration failed: ${err instanceof Error ? err.message : err}`);
    }
  } else if (bundledBin && existsSync(bundledBin)) {
    try {
      await capture(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/com.draft.daemon`]);
    } catch {
      // Non-fatal: daemon will use the new binary on next natural restart (keepalive).
    }
  }

  // Write sidecar last — if any step above threw, we'll retry on next launch.
  writeFileSync(sidecarPath, appBuildId, "utf8");
}

// ── Update helpers ─────────────────────────────────────────────────────────────

async function checkAndDownloadUpdate(silent: boolean) {
  try {
    const info = await Electrobun.Updater.checkForUpdate();
    if (!info.updateAvailable) {
      if (!silent) try { rpc.send.updateNotAvailable({}); } catch {}
      return;
    }
    await Electrobun.Updater.downloadUpdate();
    const ready = Electrobun.Updater.updateInfo()?.updateReady ?? false;
    if (ready) {
      try { rpc.send.updateAvailable({ version: info.version }); } catch {}
    }
  } catch (err) {
    if (!silent) {
      const error = err instanceof Error ? err.message : "Update check failed.";
      try { rpc.send.updateCheckFailed({ error }); } catch {}
    }
  }
}

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

// Native close can't be intercepted (no preventDefault hook like beforeQuit),
// so on close we swap in a fresh hidden window rather than reuse the dead one.
function createMainWindow(hidden: boolean) {
  const w = new BrowserWindow({
    title: "Draft",
    url: "views://app/index.html",
    titleBarStyle: "hiddenInset",
    rpc,
    hidden,
  });
  w.setFrame(180, 100, 1150, 820);
  w.on("close", () => {
    win = createMainWindow(true);
  });
  return w;
}

let win = createMainWindow(false);

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
    try { win.show(); } catch (err) { console.error("[draft-desktop] tray open failed:", err); }
  }

  if (action === "tray-stop-draft") {
    capture(["launchctl", "bootout", `gui/${process.getuid!()}/${PLIST_LABEL}`])
      .then(() => {
        setTimeout(refreshTrayMenu, 500);
        setTimeout(refreshAppMenu, 500);
        try { rpc.send.requestStatusRefresh({}); } catch {}
      })
      .catch(() => {});
  }

  if (action === "tray-start-draft") {
    if (existsSync(PLIST_PATH)) {
      Bun.spawn(["bash", `${BACKGROUND_DIR}/start.sh`], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      setTimeout(refreshTrayMenu, 1500);
      setTimeout(refreshAppMenu, 1500);
      try { rpc.send.requestStatusRefresh({}); } catch {}
    }
  }

  if (action === "quit") {
    stopHeartbeatWatch();
    stopProposalWatch();
    stopActiveProfileWatch();
    stopSkillWatch();
    stopMcpWatch();
    process.exit(0);
  }
});

// ── Startup log ───────────────────────────────────────────────────────────────
// Quick sanity check on startup. Phase 1 will push this to renderer via
// webview.messages once the dom-ready event is wired.

setTimeout(async () => {
  await syncBundledAssets(); // must run before daemon status poll

  try {
    const status  = await getDaemonStatus();
    const profile = getActiveProfile();
    console.log(`[draft-desktop] daemon=${status.state} profile=${profile}`);
    setAppMenu(status.state === "running");
    setTrayMenu(status.state === "running");
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

  // Skill and MCP watchers auto-sync between agents. Defer during onboarding so the
  // scan-import step controls what gets synced. For returning users, start immediately.
  const appState = getAppState();
  if (appState.userState !== "no-profile") {
    startSkillWatch({
      onSkillsPending: (pending) => {
        try { rpc.send.skillsPendingApproval({ pending }); } catch {}
      },
      onSkillsConflict: (conflicts) => {
        try { rpc.send.skillsConflict({ conflicts }); } catch {}
      },
      onSkillsChanged: (count) => {
        try { rpc.send.skillsChanged({ count }); } catch {}
      },
      onReconciled: (_result) => {
        // Reconcile result logged internally; no UI action needed unless repaired > 0
        // (onSkillsChanged is called separately when repaired.length > 0)
      },
    }, { activeProfile: getActiveProfile() });

    startMcpWatch({
      onMcpsPending: (pending) => {
        try { rpc.send.mcpsPendingApproval({ pending }); } catch {}
      },
      onMcpsConflict: (conflicts) => {
        try { rpc.send.mcpsConflict({ conflicts }); } catch {}
      },
      onMcpsDrifted: (drifted) => {
        try { rpc.send.mcpsDrifted({ drifted }); } catch {}
      },
      onReconciled: (_result) => {},
      onMcpsPendingCredentials: (mcps) => {
        try { rpc.send.mcpsPendingCredentials({ mcps }); } catch {}
      },
      onTeamMcpsChanged: (count) => {
        try { rpc.send.mcpsChanged({ count }); } catch {}
      },
    }, { activeProfile: getActiveProfile() });
  }

  // Watch ~/.draft/active-profile for CLI-driven profile switches (e.g. `draft switch`).
  startActiveProfileWatch({
    onProfileChanged: (profile, previousProfile) => {
      void switchProfileAssets(previousProfile, profile).catch(() => {
        // The CLI may already have completed the idempotent lifecycle. Watchers
        // still need to follow the active profile if a later rescan is required.
      }).finally(() => {
        restartProposalWatch(profile, watcherHandlers);
        restartSkillWatchWithProfile(profile);
        restartMcpWatchWithProfile(profile);
        try { rpc.send.profileChanged({ profile }); } catch {}
      });
    },
  });

  // Silent update check on launch — pushes updateAvailable if a new version is ready.
  void checkAndDownloadUpdate(true);
}, 500);
