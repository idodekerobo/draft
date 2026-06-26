// desktop/src/main/watchers/mcps.ts — cross-agent MCP config watcher with approval gate

import { existsSync, watch } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  detectMcpPending,
  reconcile,
  type PendingMcpEntry,
  type McpConflict,
  type McpDriftEntry,
  type McpReconcileResult,
  type McpSyncOpts,
} from "draft-core/sync/mcp-sync";

// 500ms debounce — config files change atomically via rename, so we want quick detection
const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 120_000;

export interface McpWatchHandlers {
  onMcpsPending: (mcps: PendingMcpEntry[]) => void;
  onMcpsConflict: (conflicts: McpConflict[]) => void;
  onMcpsDrifted: (drifted: McpDriftEntry[]) => void;
  onReconciled: (result: McpReconcileResult) => void;
}

export interface McpWatchOptions extends McpSyncOpts {
  claudeJsonPath?: string;
  codexConfigPath?: string;
}

let watchers: Array<ReturnType<typeof watch>> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function buildSyncOpts(options?: McpWatchOptions): McpSyncOpts {
  return {
    claudeConfigPath: options?.claudeConfigPath,
    codexConfigPath: options?.codexConfigPath,
    manifestPath: options?.manifestPath,
    statePath: options?.statePath,
  };
}

export function startMcpWatch(handlers: McpWatchHandlers, options?: McpWatchOptions): void {
  if (started) return;
  started = true;

  const syncOpts = buildSyncOpts(options);

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

  fallbackTimer = setInterval(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile(syncOpts).then((r) => {
        handlers.onReconciled(r);
        if (r.drifted.length > 0) handlers.onMcpsDrifted(r.drifted);
      }).catch(() => {});
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
  started = false;
}
