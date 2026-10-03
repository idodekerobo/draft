// desktop/src/index.ts — Draft desktop app: Bun main process

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import { PLIST_LABEL, PLIST_PATH } from "draft-core/status";
import { getAppState } from "draft-core/appState";
import { getActiveProfile, getWorkspacePath, readDraftConfig, writeDraftConfig, ensureAnalyticsConfig, getInstalledTools, resolveNotificationsEnabled, BACKGROUND_DIR, type AnalyticsConfig } from "draft-core/config";
import { runMigrations } from "draft-core/migrations/runner";
import { documentsToEntries } from "draft-shared-ui/context-files";
import { capture } from "./exec";
import { buildSlackManifestUrl, validateSlackTokenFormat, fetchSlackChannels } from "draft-core/integrations/slack-hosted";
import {
  normalizeHostedConnections,
  normalizeHostedConnectionList,
} from "draft-core/integrations/hosted-connections";
import { homedir } from "os";
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync, cpSync, mkdirSync, chmodSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { readLocalConfig, writeLocalConfig } from "draft-core/config";
import {
  getBundledBackgroundDir,
  getBundledDaemonBinPath,
} from "./main/bundlePath";
import { runInstall, syncExtractedBins } from "./main/installer";
import { setNotificationsEnabled } from "./main/notifications";
import { applyLoginItem } from "./main/loginItem";
import type {
  AppRPCType,
  IntegrationDetail,
  SlackChannelOption,
  SlackMembershipReconcileResult,
  SynthesisSchedule,
  WorkspaceRun,
} from "./rpc/schema";
import { startBrowserSignIn } from "./main/auth/browser-sign-in";
import { startGithubInstall } from "./main/auth/github-install";
import { AuthRefreshError, clearAuthState, getCachedWorkspaceId, readAuthState, writeAuthState } from "draft-core/auth-state";
import { getUserIdentity } from "./main/auth/user-identity";
import { getPrivacy, setPrivacy } from "./main/privacy";
import { apiUrl, fetchServer, fetchServerJSON } from "./main/server/server-client";
let browserSignInController: AbortController | null = null;
let githubInstallController: AbortController | null = null;

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
const UPLOAD_IGNORED_DIR_NAMES = new Set(["build", "dist", "out"]);

// Walks directory-by-directory, pruning ignored directory names (.git,
// node_modules, dotfiles) BEFORE descending into them
async function collectUploadFiles(rootDir: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  let totalBytes = 0;

  function walk(dir: string, relativeDir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".") ||
        UPLOAD_IGNORED_DIR_NAMES.has(entry.name) ||
        entry.name.endsWith(".app")
      ) continue;
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

function setAppMenu() {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [
        { label: "Check for Updates", action: "check-for-updates" },
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

setAppMenu();

Electrobun.events.on("application-menu-clicked", (event) => {
  const { action } = (event as { data: { action: string } }).data;

  if (action === "check-for-updates") {
    try { rpc.send.updateCheckStarted({}); } catch {}
    void checkAndDownloadUpdate(false);
  }

  if (action === "quit-app") {
    win.hide();
  }

  if (action === "quit-completely") {
    process.exit(0);
  }
});

Electrobun.events.on("reopen", () => {
  try { win.show(); } catch (err) { console.error("[draft-desktop] reopen failed:", err); }
});

// ── RPC ────────────────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<AppRPCType>({
  // Team staging can spend up to 60s cloning; promotion can then wait up to
  // 30s for the profile lock before applying assets. Keep the RPC alive for
  // the full shared-loader lifecycle so the renderer never sees a false timeout.
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      getStatus: async () => {
        const appState = getAppState();

        const toolList = getInstalledTools();
        const installedTools = {
          "claude-code": toolList.includes("claude-code"),
          codex:         toolList.includes("codex"),
          cursor:        toolList.includes("cursor"),
          openclaw:      toolList.includes("openclaw"),
          hermes:        toolList.includes("hermes"),
        };

        return { appState, installedTools };
      },

      launchSession: async () => ({
        ok: false,
        error: "not implemented — Phase 3",
      }),

      getLocalConfig: async () => {
        const workspace = getWorkspacePath(getActiveProfile());
        const result = readLocalConfig(workspace);
        const c = result.ok ? result.config : {};
        const draftResult = readDraftConfig();
        const config = draftResult.ok ? draftResult.config : { version: "1", tools: {} };
        const preference = resolveNotificationsEnabled(config.notificationsEnabled, c.notificationsEnabled);
        if (preference.migrated) writeDraftConfig({ ...config, notificationsEnabled: preference.enabled });
        return {
          launchOnLogin:             c.launchOnLogin             ?? false,
          notificationsEnabled: preference.enabled,
          disabledContextSections:   c.disabledContextSections   ?? [],
          codexScanIntervalMinutes:  c.codexScanIntervalMinutes  ?? 360,
        };
      },

      setLocalConfig: async (patch) => {
        try {
          const workspace = getWorkspacePath(getActiveProfile());
          const { notificationsEnabled, ...localPatch } = patch;
          if (Object.keys(localPatch).length > 0) writeLocalConfig(workspace, localPatch);
          if (patch.launchOnLogin !== undefined) {
            await applyLoginItem(patch.launchOnLogin);
          }
          if (notificationsEnabled !== undefined) {
            const result = readDraftConfig();
            const config = result.ok ? result.config : { version: "1", tools: {} };
            writeDraftConfig({ ...config, notificationsEnabled });
            const { setNotificationsEnabled } = await import("./main/notifications");
            setNotificationsEnabled(notificationsEnabled);
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
          const auth = readAuthState();
          if (!auth) {
            try { rpc.send.authStateChanged({ signedIn: false }); } catch {}
            return [];
          }
          const workspaceId = auth.workspace_id;
          if (!workspaceId) return [];

          // This RPC always reads the current cloud snapshot. The renderer owns
          // the session-lifetime snapshot used to survive Context tab remounts;
          // a persistent local cache/mirror remains deferred.
          const context = await fetchServerJSON<{
            documents: Record<string, { content: string; sha256: string }>;
          }>(`workspaces/${workspaceId}/context`);

          return documentsToEntries(context.documents);
        } catch (error) {
          const authFailure =
            (error instanceof AuthRefreshError && error.kind === "terminal") ||
            (error instanceof Error && /request_failed_(401|403)/.test(error.message));
          if (authFailure) {
            try { clearAuthState(); } catch {}
            try { rpc.send.authStateChanged({ signedIn: false }); } catch {}
          }
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

        // Integrations — every entry is now cloud-backed (source_connections),
        // fetched below in one round trip. No per-profile integrations.json
        // read remains for this list.
        let cloudConnections: unknown = null;
        let agentLastUsedAt: string | null = null;
        const cloudWorkspaceId = getCachedWorkspaceId();
        if (cloudWorkspaceId) {
          try {
            const response = await fetchServerJSON<{ connections: unknown; agent?: { last_used_at?: string | null } }>(
              `workspaces/${cloudWorkspaceId}/connections`,
            );
            cloudConnections = response.connections;
            agentLastUsedAt = response.agent?.last_used_at ?? null;
          } catch {
            cloudConnections = null;
          }
        }
        const hostedConnections = normalizeHostedConnections(cloudConnections ?? []);

        // Every integrationDetail key is now cloud-backed, so there's no
        // local-flag/health-file fallback branch left to maintain.
        function integrationDetail(key: "granola" | "slack" | "github" | "fireflies" | "linear"): IntegrationDetail {
          const cloud = hostedConnections.find((connection) => connection.provider === key);
          return {
            // Cloud-backed integrations must not fall back to stale local flags
            // when the server is unreachable or the user is signed out.
            connected: cloud?.connected ?? false,
            status: cloud?.status ?? "disconnected",
            healthStatus: cloud?.status === "connected" ? "healthy" : cloud?.status === "degraded" || cloud?.status === "error" ? "needs_attention" : "unknown",
            healthCheckedAt: cloud?.last_success_at ?? null,
            healthMessage: cloud?.last_error_at ? "The cloud ingestion worker reported an error." : null,
            lastConnected: cloud?.last_success_at ?? null,
            mode: null,
            channels: key === "slack" ? (cloud?.channel_ids?.length ?? 0) : null,
            channelIds: key === "slack" ? (cloud?.channel_ids ?? []) : undefined,
            displayName: cloud?.display_name ?? null,
          };
        }

        const claudeCodeConnection = hostedConnections.find((connection) => connection.provider === "claude-code");
        return {
          tools: {
            "claude-code": toolDetail("claude-code"),
            codex:         toolDetail("codex"),
            cursor:        toolDetail("cursor"),
            openclaw:      toolDetail("openclaw"),
            hermes:        toolDetail("hermes"),
          },
          integrations: {
            granola:       integrationDetail("granola"),
            slack:         integrationDetail("slack"),
            github:        integrationDetail("github"),
            fireflies:     integrationDetail("fireflies"),
            linear:        integrationDetail("linear"),
          },
          claudeCode: { connected: claudeCodeConnection?.connected ?? false },
          agentLastUsedAt,
          apiBaseUrl: apiUrl,
          webAppUrl: process.env.DRAFT_APP_URL ?? "https://app.draftai.us",
          // Settings list view only -- every other consumer above keeps
          // using the folded IntegrationDetail shape. Reuses cloudConnections
          // (already fetched once above) instead of a second round trip.
          firefliesConnections: normalizeHostedConnectionList("fireflies", cloudConnections ?? []),
          granolaConnections: normalizeHostedConnectionList("granola", cloudConnections ?? []),
        };
      },

      disconnectIntegration: async ({ source, accountKind }) => {
        try {
          const workspaceId = getCachedWorkspaceId();
          if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
          const query = source === "granola" ? `?account_kind=${accountKind ?? "personal"}` : "";
          await fetchServer(`workspaces/${workspaceId}/connections/${source}${query}`, { method: "DELETE" });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Disconnect failed." };
        }
      },

      getSynthesisSchedule: async () => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return null;
        try {
          return await fetchServerJSON<SynthesisSchedule>(`workspaces/${workspaceId}/synthesis-schedule`);
        } catch {
          return null;
        }
      },

      setSynthesisEnabled: async ({ enabled }) => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          const schedule = await fetchServerJSON<SynthesisSchedule>(`workspaces/${workspaceId}/synthesis-schedule`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          });
          return { ok: true, schedule };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not update the synthesis schedule." };
        }
      },

      startGithubInstall: async () => {
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        githubInstallController?.abort();
        githubInstallController = new AbortController();
        void startGithubInstall(workspaceId, githubInstallController.signal, {
          openUrl: (url) =>
            Bun.spawn(["open", url], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          progress: (value) => {
            try {
              rpc.send.githubInstallProgress(value);
            } catch {}
          },
        });
        return { ok: true };
      },
      cancelGithubInstall: async () => {
        githubInstallController?.abort();
        githubInstallController = null;
        return { ok: true };
      },

      runInstall: async ({ tools }) => {
        console.log(`[rpc] runInstall called — tools: ${JSON.stringify(tools)}`);
        const result = await runInstall(tools);
        console.log(`[rpc] runInstall returned — ok: ${result.ok}, steps: ${result.steps.length}`);
        return result;
      },

      connectGranola: async ({ apiKey, accountKind }) => {
        if (!apiKey.trim()) return { ok: false, error: "Enter your Granola API key." };
        const workspaceId = getCachedWorkspaceId();
        if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
        try {
          return await fetchServerJSON<{ ok: true }>(`workspaces/${workspaceId}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "granola", api_token: apiKey.trim(), account_kind: accountKind }),
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not connect Granola." };
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
          return { ok: true, channels: result.channels };
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
        if (!workspaceId) return {
          ok: false,
          channelIds: [],
          joined: [],
          left: [],
          failed: [],
          error: "Sign in to Draft Cloud first.",
        };
        try {
          const result = await fetchServerJSON<{
            ok: boolean;
            channel_ids: string[];
            joined: string[];
            left: string[];
            failed: Array<{
              channel_id: string;
              operation: "join" | "leave";
              code: "slack_channel_join_failed" | "slack_channel_leave_failed";
            }>;
          }>(`workspaces/${workspaceId}/connections/slack`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel_ids: channelIds }),
          });
          return {
            ok: result.ok,
            channelIds: result.channel_ids,
            joined: result.joined,
            left: result.left,
            failed: result.failed.map((failure) => ({
              channelId: failure.channel_id,
              operation: failure.operation,
              code: failure.code,
            })),
          } satisfies SlackMembershipReconcileResult;
        } catch (err) {
          return {
            ok: false,
            channelIds: [],
            joined: [],
            left: [],
            failed: [],
            error: err instanceof Error ? err.message : "Could not update Slack channels.",
          };
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

      getPrivacy: async ({ signedIn }) => getPrivacy(signedIn),

      setPrivacy: async (patch) => {
        try {
          return { ok: true, privacy: await setPrivacy(patch) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Could not save your privacy choice." };
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
  if (process.env.DRAFT_DESKTOP_DEV === "1") return;
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
  // Keep the Codex scanner and synthesis runtime in lockstep with the daemon
  // binary while preserving user-generated queues, state, and logs.
  const backgroundDir = getBundledBackgroundDir();
  const runtimeFiles = [
    "install.sh",
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
          cpSync(join(sourceDir, entry), join(BACKGROUND_DIR, relativeDir, entry), {
            recursive: true,
            force: true,
          });
        }
      }

      // The build manifest is an explicit allowlist of bundled JS entrypoints.
      // Remove their raw-TS predecessors so Bun does not prefer stale source.
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

// ── Startup log ───────────────────────────────────────────────────────────────
// Quick sanity check on startup. Phase 1 will push this to renderer via
// webview.messages once the dom-ready event is wired.

setTimeout(async () => {
  await syncBundledAssets();

  const profile = getActiveProfile();
  console.log(`[draft-desktop] profile=${profile}`);

  const globalConfigResult = readDraftConfig();
  const globalConfig = globalConfigResult.ok ? globalConfigResult.config : { version: "1", tools: {} };
  const localConfig = readLocalConfig(getWorkspacePath(profile));
  const preference = resolveNotificationsEnabled(globalConfig.notificationsEnabled, localConfig.ok ? localConfig.config.notificationsEnabled : undefined);
  if (preference.migrated) writeDraftConfig({ ...globalConfig, notificationsEnabled: preference.enabled });
  setNotificationsEnabled(preference.enabled);

  // Silent update check on launch — pushes updateAvailable if a new version is ready.
  void checkAndDownloadUpdate(true);
}, 500);
