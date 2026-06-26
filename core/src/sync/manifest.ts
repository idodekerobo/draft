// core/src/sync/manifest.ts — MCP manifest read/write/tombstone

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

export type Agent = "claude-code" | "codex";

export interface CanonicalMcp {
  type: "http";
  url: string;
  headers?: Record<string, {
    value_env?: string;
    value_literal?: string;
    secret: boolean;
  }>;
  disabled?: boolean;
}

export interface McpManifestSyncEntry {
  synced_at: string;
  target_name: string;
}

export interface McpManifestEntry {
  id: string;
  name: string;
  source_agent: Agent;
  sync_canonical: CanonicalMcp;
  sync_canonical_hash: string;
  source_snapshot: { original_config: Record<string, unknown> };
  env_var_mapping: Record<string, string>;
  synced_to: Partial<Record<Agent, McpManifestSyncEntry>>;
  removed_at: string | null;
}

export interface McpManifest {
  version: 4;
  schema_version: 4;
  mcps: Record<string, McpManifestEntry>;
  name_conflicts: Record<string, {
    agents: Agent[];
    resolved: boolean;
    authoritative_agent: Agent | null;
  }>;
}

const STATE_DIR = join(homedir(), ".draft", "state");
const DEFAULT_MCP_MANIFEST_PATH = join(STATE_DIR, "mcp-manifest.json");

function emptyMcpManifest(): McpManifest {
  return {
    version: 4,
    schema_version: 4,
    mcps: {},
    name_conflicts: {},
  };
}

export function hashCanonical(canonical: CanonicalMcp): string {
  // Sort keys for stable hash
  const sorted = JSON.parse(JSON.stringify(canonical, Object.keys(canonical).sort()));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}

export function readMcpManifest(manifestPath?: string): McpManifest {
  const path = manifestPath ?? DEFAULT_MCP_MANIFEST_PATH;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version === 4 && parsed?.mcps) return parsed as McpManifest;
  } catch { /* missing or malformed */ }
  return emptyMcpManifest();
}

/** Atomic write: tmp → rename. */
export function writeMcpManifest(manifest: McpManifest, manifestPath?: string): void {
  const path = manifestPath ?? DEFAULT_MCP_MANIFEST_PATH;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Mark an MCP manifest entry as tombstoned (removed). */
export function tombstoneMcp(id: string, manifestPath?: string): void {
  const manifest = readMcpManifest(manifestPath);
  if (!manifest.mcps[id]) return;
  manifest.mcps[id] = { ...manifest.mcps[id], removed_at: new Date().toISOString() };
  writeMcpManifest(manifest, manifestPath);
}
