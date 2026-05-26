// utils/config.ts — read Draft config files
//
// All functions return typed values. Missing files and parse errors are handled
// gracefully — callers never need to try/catch config reads.

import { join } from "path";
import { readFileSync } from "fs";

const DRAFT_GLOBAL = `${process.env.HOME}/.draft`;

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

// ── Collaboration schema ────────────────────────────────────────────────────────
export interface Collaboration {
  mode?: string;
  team_repo_url?: string;
  team_repo_subdir?: string;
  teammates?: string[];
}

// ── Profile resolution ─────────────────────────────────────────────────────────

export function getActiveProfile(): string {
  const profileFile = `${DRAFT_GLOBAL}/active-profile`;
  try {
    const raw = readFileSync(profileFile, "utf8").trim();
    return raw || "default";
  } catch {
    return "default";
  }
}

export function getWorkspacePath(profile?: string): string {
  const active = profile ?? getActiveProfile();
  return `${DRAFT_GLOBAL}/workspaces/${active}`;
}

// ── Secrets ────────────────────────────────────────────────────────────────────

export type SecretsResult =
  | { ok: true; secrets: Secrets }
  | { ok: false; reason: "missing" | "malformed" };

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

export type CollabResult =
  | { ok: true; collab: Collaboration }
  | { ok: false; reason: "missing" | "malformed" };

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

// ── Repo root detection ────────────────────────────────────────────────────────
// Walk up from this file's location until we find the repo root.
// Marker: the directory contains "cli-agent-plugin/".

export function getRepoRoot(): string {
  // import.meta.dir resolves to cli/src/utils/ at runtime
  const parts = import.meta.dir.split("/");
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join("/");
    const marker = join(candidate, "cli-agent-plugin", "settings.json");
    try {
      readFileSync(marker, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  // Fallback: assume we're being run from repo root
  return process.cwd();
}
