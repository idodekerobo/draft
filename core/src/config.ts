// core/src/config.ts — shared path constants and config file readers
//
// Used by: draft-cli, draft-desktop
// All functions return typed values. Missing files and parse errors are handled
// gracefully — callers never need to try/catch config reads.

import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";

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
  replay_enabled: boolean;
  anonymous_id: string;
  posthog_host?: string;
  posthog_key?: string;
}

export interface DraftConfig {
  version: string;
  plugin_version?: string;
  tools: Partial<Record<InstalledTool, ToolEntry>>;
  last_update_check?: UpdateCheckEntry;
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
    replay_enabled: false,
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
  granola_mode?: "mcp" | "api";
  granola_api_token?: string;
  slack_bot_token?: string;
  slack_app_token?: string;
  slack_allowlist_channels?: string[];
  slack_capture_mode?: "passive" | "tagged";
  slack_analysis_window_hours?: number;
}

// ── Integrations schema ────────────────────────────────────────────────────────

export interface IntegrationEntry {
  connected: boolean;
  mode?: string;
  workspace?: string;
  channels?: number;
  repos?: string[];
  last_connected?: string;
}

export interface Integrations {
  granola?: IntegrationEntry;
  slack?: IntegrationEntry;
  github?: IntegrationEntry;
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
  team_repo_url?: string;
  team_repo_subdir?: string;
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

// ── Profile list ───────────────────────────────────────────────────────────────

export interface ProfileDetail {
  name: string;
  /** True if the workspace has at least one .md file under its context/ directory. */
  hasContext: boolean;
}

export interface ProfileList {
  /** All profile names, sorted alphabetically. */
  names: string[];
  /** The currently active profile (never empty — falls back to "default"). */
  active: string;
  details: ProfileDetail[];
}

/** Recursively check if a directory contains at least one .md file. */
function hasMarkdownInDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (hasMarkdownInDir(join(dir, entry.name))) return true;
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * List all named profiles under ~/.draft/workspaces/.
 * Returns the data layer only — callers own the print/display logic.
 *
 * Pass `opts` to override path constants (used in tests).
 */
export function getProfiles(opts?: ProfileOpts): ProfileList {
  const wsDir = opts?.workspacesDir ?? WORKSPACES_DIR;
  const active = getActiveProfile(opts);
  if (!existsSync(wsDir)) return { names: [], active, details: [] };
  try {
    const names = readdirSync(wsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const details: ProfileDetail[] = names.map((name) => ({
      name,
      hasContext: hasMarkdownInDir(join(wsDir, name, "context")),
    }));
    return { names, active, details };
  } catch {
    return { names: [], active, details: [] };
  }
}

export type CreateProfileResult =
  | { ok: true; name: string }
  | { ok: false; reason: "invalid" | "exists" };

/**
 * Create a new named profile (workspace directory) and set it as active.
 * Fails if the name is invalid or the directory already exists.
 */
export function createProfile(name: string, opts?: ProfileOpts): CreateProfileResult {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { ok: false, reason: "invalid" };
  }
  const wsPath = getWorkspacePath(trimmed, opts);
  if (existsSync(wsPath)) {
    return { ok: false, reason: "exists" };
  }
  mkdirSync(wsPath, { recursive: true });
  return { ok: true, name: trimmed };
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
  teamLoadMode?: "auto" | "review";
  launchOnLogin?: boolean;
  notificationsEnabled?: boolean;
  last_loaded?: string;
  last_published?: string;
  lastLoadCursor?: number;
  disabledContextSections?: string[];
  codexScanIntervalMinutes?: number | null;
  claudeCodeSynthesis?: boolean;
  team_assets?: {
    baseline?: {
      skills_hash: string;
      mcp_hash: string;
    };
    last_remote?: {
      skills_hash: string;
      mcp_hash: string;
    };
  };
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
