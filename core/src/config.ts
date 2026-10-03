// core/src/config.ts — shared path constants and config file readers
//
// Used by: draft-cli, draft-desktop
// All functions return typed values. Missing files and parse errors are handled
// gracefully — callers never need to try/catch config reads.

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ── Path constants ─────────────────────────────────────────────────────────────

export const DRAFT_ROOT          = `${process.env.HOME}/.draft`;
export const WORKSPACES_DIR      = `${DRAFT_ROOT}/workspaces`;
export const BACKGROUND_DIR      = `${DRAFT_ROOT}/background`;
export const ACTIVE_PROFILE_FILE = `${DRAFT_ROOT}/active-profile`;
export const DRAFT_CONFIG_FILE   = `${DRAFT_ROOT}/config.json`;

// ── Global config schema ────────────────────────────────────────────────────────

export type InstalledTool = "claude-code" | "codex" | "cursor" | "openclaw" | "hermes";

export interface ToolEntry {
  /** ISO 8601 timestamp. "migrated" for auto-detected legacy installs. */
  added_at: string;
  /** Absolute path to cli-agent-plugin repo root. Claude Code only. */
  plugin_root?: string;
}

export interface UpdateCheckEntry {
  status: "UP_TO_DATE" | "UPGRADE_AVAILABLE";
  installed_version: string;
  latest_version: string;
  checked_at: string;
}

export interface AnalyticsConfig {
  consent: "pending" | "opted_in" | "opted_out";
  anonymous_id: string;
  posthog_host?: string;
  posthog_key?: string;
}

export interface DraftConfig {
  version: string;
  plugin_version?: string;
  /** Version of the installed `draft` CLI binary at ~/.draft/bin/draft. */
  cli_version?: string;
  tools: Partial<Record<InstalledTool, ToolEntry>>;
  last_update_check?: UpdateCheckEntry;
  /** Separate from last_update_check (plugin) — tracks the CLI binary release channel. */
  last_cli_update_check?: UpdateCheckEntry;
  analytics?: AnalyticsConfig;
  last_migration?: number;
}

/**
 * Returns existing analytics config or creates a fresh one with a new anonymous_id.
 * Does NOT write to disk — callers decide whether to persist.
 */
export function ensureAnalyticsConfig(config: DraftConfig): AnalyticsConfig {
  if (config.analytics?.anonymous_id) return config.analytics;
  return {
    consent: "pending",
    anonymous_id: crypto.randomUUID(),
    ...config.analytics,
  };
}

export type DraftConfigResult =
  | { ok: true; config: DraftConfig }
  | { ok: false; reason: "missing" | "malformed" };

export function readDraftConfig(): DraftConfigResult {
  let raw: string;
  try {
    raw = readFileSync(DRAFT_CONFIG_FILE, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as DraftConfig;
    return { ok: true, config: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function writeDraftConfig(config: DraftConfig): void {
  mkdirSync(DRAFT_ROOT, { recursive: true });
  writeFileSync(DRAFT_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Upsert a single tool entry. Preserves all other config fields. */
export function writeToolConfig(tool: InstalledTool, entry: ToolEntry): void {
  const result = readDraftConfig();
  const current: DraftConfig =
    result.ok ? result.config : { version: "1", tools: {} };
  current.tools = { ...current.tools, [tool]: entry };
  writeDraftConfig(current);
}

/**
 * Returns tools the user has installed Draft into.
 * Reads config.json only — no filesystem heuristics.
 * Returns [] if config.json is missing or malformed.
 */
export function getInstalledTools(): InstalledTool[] {
  const result = readDraftConfig();
  if (!result.ok) return [];
  return Object.keys(result.config.tools ?? {}) as InstalledTool[];
}

// ── Secrets schema ─────────────────────────────────────────────────────────────

export interface Secrets {
  github_connected?: boolean;
  fireflies_api_token?: string;
  slack_bot_token?: string;
  slack_app_token?: string;
  slack_allowlist_channels?: string[];
  slack_capture_mode?: "passive" | "tagged";
  slack_analysis_window_hours?: number;
  /** GitHub Device Flow OAuth token — used for the API-based team-load transport. */
  github_oauth_token?: string;
  /** Display only — never log/analytics. */
  github_oauth_login?: string;
}

// ── Integrations schema ────────────────────────────────────────────────────────

export interface IntegrationEntry {
  connected: boolean;
  /** Exact Claude MCP server ID selected during setup. */
  mcp_server_id?: string;
  mode?: string;
  workspace?: string;
  channels?: number;
  repos?: string[];
  last_connected?: string;
  /** How this integration got connected. Absent means the legacy gh-CLI flow. */
  via?: "gh-cli" | "oauth-device-flow";
}

export interface Integrations {
  slack?: IntegrationEntry;
  github?: IntegrationEntry;
  fireflies?: IntegrationEntry;
}

export type IntegrationsResult =
  | { ok: true; integrations: Integrations }
  | { ok: false; reason: "missing" | "malformed" };

export type SecretsResult =
  | { ok: true; secrets: Secrets }
  | { ok: false; reason: "missing" | "malformed" };

// ── Collaboration schema ────────────────────────────────────────────────────────

export interface Collaboration {
  mode?: string;
  teammates?: string[];
}

export type CollabResult =
  | { ok: true; collab: Collaboration }
  | { ok: false; reason: "missing" | "malformed" };

// ── Profile resolution ─────────────────────────────────────────────────────────

export interface ProfileOpts {
  /** Override ~/.draft/active-profile path. Used in tests. */
  activeProfileFile?: string;
  /** Override ~/.draft/workspaces path. Used in tests. */
  workspacesDir?: string;
}

export function getActiveProfile(opts?: ProfileOpts): string {
  const file = opts?.activeProfileFile ?? ACTIVE_PROFILE_FILE;
  try {
    const raw = readFileSync(file, "utf8").trim();
    return raw || "default";
  } catch {
    return "default";
  }
}

export function getWorkspacePath(profile?: string, opts?: ProfileOpts): string {
  const wsDir  = opts?.workspacesDir ?? WORKSPACES_DIR;
  const active = profile ?? getActiveProfile(opts);
  return `${wsDir}/${active}`;
}

export function getSkillManifestPath(profile?: string, opts?: ProfileOpts): string {
  return join(getWorkspacePath(profile, opts), "config", "skill-manifest.json");
}

export function getMcpManifestPath(profile?: string, opts?: ProfileOpts): string {
  return join(getWorkspacePath(profile, opts), "config", "mcp-manifest.json");
}

export type SetActiveProfileResult =
  | { ok: true; active: string }
  | { ok: false; reason: "invalid" | "missing" };

export function setActiveProfile(profile: string, opts?: ProfileOpts): SetActiveProfileResult {
  const name = profile.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { ok: false, reason: "invalid" };
  }

  const workspacePath = getWorkspacePath(name, opts);
  if (!existsSync(workspacePath)) {
    return { ok: false, reason: "missing" };
  }

  const activeProfileFile = opts?.activeProfileFile ?? ACTIVE_PROFILE_FILE;
  const parentDir = activeProfileFile.slice(0, activeProfileFile.lastIndexOf("/"));
  if (parentDir) mkdirSync(parentDir, { recursive: true });
  writeFileSync(activeProfileFile, `${name}\n`, "utf8");
  return { ok: true, active: name };
}

// ── Secrets ────────────────────────────────────────────────────────────────────

export function readSecrets(workspacePath: string): SecretsResult {
  const secretsPath = join(workspacePath, "config", "secrets.json");
  let raw: string;
  try {
    raw = readFileSync(secretsPath, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as Secrets;
    return { ok: true, secrets: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Merge a credentials patch into the profile's secrets file.
 * This preserves credentials for integrations configured separately.
 */
export function writeSecrets(workspacePath: string, patch: Partial<Secrets>): void {
  const secretsPath = join(workspacePath, "config", "secrets.json");
  const existing = readSecrets(workspacePath);
  const secrets = { ...(existing.ok ? existing.secrets : {}), ...patch };
  mkdirSync(join(workspacePath, "config"), { recursive: true });
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", "utf8");
}

export function readIntegrations(workspacePath: string): IntegrationsResult {
  const intPath = join(workspacePath, "config", "integrations.json");
  let raw: string;
  try {
    raw = readFileSync(intPath, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as Integrations;
    return { ok: true, integrations: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function writeIntegrations(workspacePath: string, integrations: Integrations): void {
  const intPath = join(workspacePath, "config", "integrations.json");
  mkdirSync(join(workspacePath, "config"), { recursive: true });
  writeFileSync(intPath, JSON.stringify(integrations, null, 2) + "\n", "utf8");
}

// ── Collaboration config ────────────────────────────────────────────────────────

// ── Local (per-machine, per-profile) config ─────────────────────────────────────

export interface LocalConfig {
  launchOnLogin?: boolean;
  notificationsEnabled?: boolean;
  disabledContextSections?: string[];
  codexScanIntervalMinutes?: number | null;
  claudeCodeSynthesis?: boolean;
}

export type LocalConfigResult =
  | { ok: true; config: LocalConfig }
  | { ok: false; reason: "missing" | "malformed" };

export function readLocalConfig(workspacePath: string): LocalConfigResult {
  const localPath = join(workspacePath, "config", "local.json");
  let raw: string;
  try {
    raw = readFileSync(localPath, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as LocalConfig;
    return { ok: true, config: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Patch-based write — merges patch into existing config so individual keys don't clobber each other. */
export function writeLocalConfig(workspacePath: string, patch: Partial<LocalConfig>): void {
  const localPath = join(workspacePath, "config", "local.json");
  const result = readLocalConfig(workspacePath);
  const current: LocalConfig = result.ok ? result.config : {};
  const updated = { ...current, ...patch };
  mkdirSync(join(workspacePath, "config"), { recursive: true });
  writeFileSync(localPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

// ── Collaboration config ────────────────────────────────────────────────────────

export function readCollaboration(workspacePath: string): CollabResult {
  const collabPath = join(workspacePath, "config", "collaboration.json");
  let raw: string;
  try {
    raw = readFileSync(collabPath, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as Collaboration;
    return { ok: true, collab: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Patch-based write — merges patch into existing collaboration.json so individual keys don't clobber each other. */
export function writeCollaboration(workspacePath: string, patch: Partial<Collaboration>): void {
  const collabPath = join(workspacePath, "config", "collaboration.json");
  const result = readCollaboration(workspacePath);
  const current: Collaboration = result.ok ? result.collab : {};
  const updated = { ...current, ...patch };
  mkdirSync(join(workspacePath, "config"), { recursive: true });
  writeFileSync(collabPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
}
