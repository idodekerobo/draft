// desktop/src/main/watchers/mcps.ts — cross-agent MCP config watcher with approval gate

import { existsSync, mkdirSync, watch } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import {
  detectMcpPending,
  reconcile,
  installTeamMcps,
  uninstallTeamMcp,
  type PendingMcpEntry,
  type McpConflict,
  type McpDriftEntry,
  type McpReconcileResult,
  type McpSyncOpts,
} from "draft-core/sync/mcp-sync";
import { readWorkspaceMcpManifest, type WorkspaceMcpEntry } from "draft-core/sync/workspace-mcp";
import { hashCanonical } from "draft-core/sync/manifest";

// 500ms debounce — config files change atomically via rename, so we want quick detection
const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 120_000;

export interface McpWatchHandlers {
  onMcpsPending: (mcps: PendingMcpEntry[]) => void;
  onMcpsConflict: (conflicts: McpConflict[]) => void;
  onMcpsDrifted: (drifted: McpDriftEntry[]) => void;
  onReconciled: (result: McpReconcileResult) => void;
  /** Fired when team MCPs have missing secrets after load-team or profile switch. */
  onMcpsPendingCredentials?: (mcps: Array<{ name: string; url: string; required_secrets: string[] }>) => void;
  /** Fired when team MCPs are installed or removed (e.g. after draft load). */
  onTeamMcpsChanged?: (count: number) => void;
}

export interface McpWatchOptions extends McpSyncOpts {
  claudeJsonPath?: string;
  codexConfigPath?: string;
  /** Active profile name — used to watch workspace/config/mcp.json for team MCPs. */
  activeProfile?: string;
  workspacesDir?: string;
}

let watchers: Array<ReturnType<typeof watch>> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let currentHandlers: McpWatchHandlers | null = null;
let currentOptions: McpWatchOptions | undefined;
let knownWorkspaceMcps = new Map<string, string>();

function buildSyncOpts(options?: McpWatchOptions): McpSyncOpts {
  return {
    claudeConfigPath: options?.claudeConfigPath,
    codexConfigPath: options?.codexConfigPath,
    manifestPath: options?.manifestPath,
    statePath: options?.statePath,
  };
}

function getWorkspaceMcpPath(options?: McpWatchOptions): string | null {
  if (!options?.activeProfile) return null;
  const wsDir = options.workspacesDir ?? `${homedir()}/.draft/workspaces`;
  return join(wsDir, options.activeProfile, "config", "mcp.json");
}

function getWorkspacePath(options?: McpWatchOptions): string | null {
  if (!options?.activeProfile) return null;
  const wsDir = options.workspacesDir ?? `${homedir()}/.draft/workspaces`;
  return join(wsDir, options.activeProfile);
}

async function handleWorkspaceMcpChange(handlers: McpWatchHandlers, options?: McpWatchOptions): Promise<void> {
  const wsPath = getWorkspacePath(options);
  if (!wsPath || !options?.activeProfile) return;

  const wsManifest = readWorkspaceMcpManifest(wsPath);
  const syncOpts = buildSyncOpts(options);
  const current = new Map(wsManifest.servers.map((entry) => [entry.name, hashCanonical(entry.canonical)]));
  const removed = [...knownWorkspaceMcps.keys()].filter((name) => !current.has(name));
  const changed = wsManifest.servers.filter((entry) => knownWorkspaceMcps.get(entry.name) !== current.get(entry.name));
  knownWorkspaceMcps = current;

  for (const name of removed) {
    try { await uninstallTeamMcp(options.activeProfile, name, syncOpts); } catch { /* non-fatal */ }
  }
  if (changed.length > 0) {
    try {
      const result = await installTeamMcps(changed, wsPath, options.activeProfile, syncOpts);
      if (result.missing_secrets.length > 0) {
        handlers.onMcpsPendingCredentials?.(result.missing_secrets.map((missing) => ({
          ...missing,
          url: wsManifest.servers.find((server) => server.name === missing.name)?.canonical.url ?? "",
        })));
      }
    } catch { /* non-fatal */ }
  }
  const totalChanged = removed.length + changed.length;
  if (totalChanged > 0) handlers.onTeamMcpsChanged?.(totalChanged);
}

export function startMcpWatch(handlers: McpWatchHandlers, options?: McpWatchOptions): void {
  if (started) return;
  started = true;
  currentHandlers = handlers;
  currentOptions = options;

  const syncOpts = buildSyncOpts(options);

  // Install any team MCPs from workspace that aren't yet configured
  const wsPath = getWorkspacePath(options);
  if (wsPath && options?.activeProfile) {
    const wsManifest = readWorkspaceMcpManifest(wsPath);
    knownWorkspaceMcps = new Map(wsManifest.servers.map((entry) => [entry.name, hashCanonical(entry.canonical)]));
    if (wsManifest.servers.length > 0) {
      installTeamMcps(wsManifest.servers, wsPath, options.activeProfile, syncOpts)
        .then((result) => {
          if (result.missing_secrets.length > 0) {
            handlers.onMcpsPendingCredentials?.(result.missing_secrets.map((missing) => ({
              ...missing,
              url: wsManifest.servers.find((server) => server.name === missing.name)?.canonical.url ?? "",
            })));
          }
        })
        .catch(() => { /* non-fatal */ });
    }
  }

  // Startup reconcile before setting up watchers
  reconcile(syncOpts)
    .then((result) => {
      handlers.onReconciled(result);
      if (result.drifted.length > 0) handlers.onMcpsDrifted(result.drifted);
    })
    .catch(() => { /* reconcile failure must not prevent watcher from starting */ });

  // Initial pending check
  try {
    const { pending, conflicts } = detectMcpPending(syncOpts);
    if (pending.length > 0) handlers.onMcpsPending(pending);
    if (conflicts.length > 0) handlers.onMcpsConflict(conflicts);
  } catch { /* non-fatal */ }

  const onConfigChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      // Run reconcile for already-synced entries (drift/removal detection)
      reconcile(syncOpts)
        .then((result) => {
          handlers.onReconciled(result);
          if (result.drifted.length > 0) handlers.onMcpsDrifted(result.drifted);
        })
        .catch(() => {});

      // Check for new pending entries
      try {
        const { pending, conflicts } = detectMcpPending(syncOpts);
        if (pending.length > 0) handlers.onMcpsPending(pending);
        if (conflicts.length > 0) handlers.onMcpsConflict(conflicts);
      } catch { /* non-fatal */ }
    }, DEBOUNCE_MS);
  };

  const configPaths = [
    options?.claudeConfigPath ?? join(homedir(), ".claude.json"),
    options?.codexConfigPath ?? join(homedir(), ".codex", "config.toml"),
  ];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      watchers.push(watch(configPath, { persistent: false }, onConfigChange));
    } catch {
      // Missing permission must not prevent the other config from watching
    }
  }

  // Watch the parent directory so initial creation and atomic replacement are observed.
  const workspaceMcpPath = getWorkspaceMcpPath(options);
  if (workspaceMcpPath) {
    try {
      mkdirSync(dirname(workspaceMcpPath), { recursive: true });
    } catch { /* non-fatal */ }
    try {
        watchers.push(watch(dirname(workspaceMcpPath), { persistent: false }, (_event, filename) => {
          if (filename && filename !== "mcp.json") return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void handleWorkspaceMcpChange(handlers, options);
            onConfigChange();
          }, DEBOUNCE_MS);
        }));
      } catch { /* non-fatal */ }
  }

  fallbackTimer = setInterval(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile(syncOpts).then((r) => {
        handlers.onReconciled(r);
        if (r.drifted.length > 0) handlers.onMcpsDrifted(r.drifted);
      }).catch(() => {});
      void handleWorkspaceMcpChange(handlers, options);
    }, DEBOUNCE_MS);
  }, FALLBACK_POLL_MS);
}

export function stopMcpWatch(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  currentHandlers = null;
  currentOptions = undefined;
  started = false;
}

/**
 * Restart the MCP watcher with a new active profile.
 * Called from the switchProfile RPC handler after profile switch completes.
 */
export function restartMcpWatchWithProfile(newProfile: string): void {
  if (!currentHandlers) return;
  const handlers = currentHandlers;
  const options = { ...currentOptions, activeProfile: newProfile };
  stopMcpWatch();
  startMcpWatch(handlers, options);
}
