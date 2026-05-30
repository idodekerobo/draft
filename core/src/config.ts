// core/src/config.ts — shared path constants and config file readers
//
// Used by: draft-cli, draft-desktop
// All functions return typed values. Missing files and parse errors are handled
// gracefully — callers never need to try/catch config reads.

import { join } from "path";
import { readFileSync } from "fs";

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
  github_connected?: boolean;
}

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

export function getActiveProfile(): string {
  try {
    const raw = readFileSync(ACTIVE_PROFILE_FILE, "utf8").trim();
    return raw || "default";
  } catch {
    return "default";
  }
}

export function getWorkspacePath(profile?: string): string {
  const active = profile ?? getActiveProfile();
  return `${WORKSPACES_DIR}/${active}`;
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
