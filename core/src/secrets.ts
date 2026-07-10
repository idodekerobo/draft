// core/src/secrets.ts — secret detection, env var naming, secrets.json + env.sh write

import { openSync, writeSync, closeSync, mkdirSync, readFileSync, existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { constants } from "fs";

const DEFAULT_STATE_PATH = join(homedir(), ".draft", "state");

/**
 * Returns true for header names that always contain secrets.
 * Authorization is the canonical case; everything else is asked of the user.
 */
export function isSecretHeader(headerName: string): boolean {
  return headerName.toLowerCase() === "authorization";
}

/**
 * Generate a stable, collision-resistant env var name for an MCP token.
 * Format: DRAFT_MCP_{SANITIZED_NAME}_{6CHAR_HASH}_TOKEN
 */
export function generateEnvVarName(sourceAgent: string, mcpName: string): string {
  // SANITIZED_NAME: uppercase, non-alphanumeric → _, strip leading digits
  let sanitized = mcpName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  sanitized = sanitized.replace(/^[0-9_]+/, "");
  if (!sanitized || sanitized.startsWith("_")) sanitized = `MCP_${sanitized.replace(/^_+/, "")}`;
  if (!sanitized) sanitized = "MCP";

  const hash = createHash("sha256")
    .update(`${sourceAgent}:${mcpName}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();

  return `DRAFT_MCP_${sanitized}_${hash}_TOKEN`;
}

function ensureStateDirPermissions(statePath: string): void {
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
}

/** Write a file with mode 0600 using fd-based create — no chmod-after window. */
function writeSecure(filePath: string, content: string): void {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeSync(fd, content, 0, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Merge new entries into ~/.draft/state/secrets.json.
 * Existing keys are preserved; new keys are added/updated.
 * File is always written with mode 0600.
 */
export function writeSecretsJson(entry: Record<string, string>, statePath?: string): void {
  const dir = statePath ?? DEFAULT_STATE_PATH;
  ensureStateDirPermissions(dir);
  const filePath = join(dir, "secrets.json");
  let existing: Record<string, string> = {};
  if (existsSync(filePath)) {
    try { existing = JSON.parse(readFileSync(filePath, "utf8")); } catch { /* start fresh */ }
  }
  const merged = { ...existing, ...entry };
  // Atomic: tmp → rename
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeSecure(tmp, JSON.stringify(merged, null, 2) + "\n");
  renameSync(tmp, filePath);
}

/**
 * Write ~/.draft/state/env.sh exporting all Draft-managed tokens.
 * Regenerates the full file from the provided vars map.
 * File is always written with mode 0600.
 */
export function writeEnvSh(vars: Record<string, string>, statePath?: string): void {
  const dir = statePath ?? DEFAULT_STATE_PATH;
  ensureStateDirPermissions(dir);
  const filePath = join(dir, "env.sh");
  const lines = [
    "# Draft-managed MCP tokens — sourced by ~/.draft/state/env.sh",
    "# Add `source ~/.draft/state/env.sh` to your shell profile for Codex bearer auth.",
    "",
    ...Object.entries(vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
    "",
  ];
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeSecure(tmp, lines.join("\n"));
  renameSync(tmp, filePath);
}

/**
 * Read all secrets from ~/.draft/state/secrets.json.
 * Returns empty object if file is missing or malformed.
 */
export function readSecretsJson(statePath?: string): Record<string, string> {
  const dir = statePath ?? DEFAULT_STATE_PATH;
  const filePath = join(dir, "secrets.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Merged secret lookup: profile-scoped values win, global values fill in
 * anything missing. Team-MCP reads go through this so a secret that only
 * exists globally (legacy desktop writes went to the global file) still
 * resolves. Lookup only — never persist this merged view back to a profile
 * file, or global legacy values get copied wholesale into every profile.
 */
export function readSecretsWithGlobalFallback(statePath?: string, globalStatePath?: string): Record<string, string> {
  if (!statePath) return readSecretsJson(globalStatePath);
  return { ...readSecretsJson(globalStatePath), ...readSecretsJson(statePath) };
}
