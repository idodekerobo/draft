// core/src/config.ts — shared path constants and config file readers
//
// Used by: draft-cli, draft-desktop
// All functions return typed values. Missing files and parse errors are handled
// gracefully — callers never need to try/catch config reads.

import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";

// ── Global config schema ────────────────────────────────────────────────────────

export const DRAFT_CONFIG_FILE = `${process.env.HOME}/.draft/config.json`;

export type InstalledTool = "claude-code" | "codex" | "cursor";

export interface ToolEntry {
  /** ISO 8601 timestamp of when the tool was added. "migrated" for auto-detected legacy installs. */
  added_at: string;
  /** Absolute path to the cli-agent-plugin repo root. Claude Code only. */
  plugin_root?: string;
}

export interface UpdateCheckEntry {
  status: "UP_TO_DATE" | "UPGRADE_AVAILABLE";
  installed_version: string;
  latest_version: string;
  checked_at: string;
}

export interface DraftConfig {
  version: string;
  /** Installed plugin version — absorbed from ~/.draft/version. */
  plugin_version?: string;
  /** Which coding tools have been set up with Draft. Absence of a key = never installed. */
  tools: Partial<Record<InstalledTool, ToolEntry>>;
  /** Cached result of the last update check — absorbed from ~/.draft/last-update-check. */
  last_update_check?: UpdateCheckEntry;
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
  mkdirSync(`${process.env.HOME}/.draft`, { recursive: true });
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
 * Returns the list of tools the user has installed Draft into.
 * Reads from config.json only — no filesystem heuristics.
 * Returns an empty array if config.json is missing or malformed.
 */
export function getInstalledTools(): InstalledTool[] {
  const result = readDraftConfig();
  if (!result.ok) return [];
  return Object.keys(result.config.tools ?? {}) as InstalledTool[];
}

// ── Path constants ─────────────────────────────────────────────────────────────

export const DRAFT_ROOT          = `${process.env.HOME}/.draft`;
export const WORKSPACES_DIR      = `${DRAFT_ROOT}/workspaces`;
export const BACKGROUND_DIR      = `${DRAFT_ROOT}/background`;
export const ACTIVE_PROFILE_FILE = `${DRAFT_ROOT}/active-profile`;

// ── Secrets schema ─────────────────────────────────────────────────────────────

export interface Secrets {
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

// ── Profile list ───────────────────────────────────────────────────────────────

export interface ProfileList {
  /** All profile names, sorted alphabetically. */
  names: string[];
  /** The currently active profile (never empty — falls back to "default"). */
  active: string;
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
  if (!existsSync(wsDir)) return { names: [], active };
  try {
    const names = readdirSync(wsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return { names, active };
  } catch {
    return { names: [], active };
  }
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
