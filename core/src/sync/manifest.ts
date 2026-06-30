// core/src/sync/manifest.ts — MCP manifest read/write/tombstone

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { getMcpManifestPath, getActiveProfile } from "../config";

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
  /** Whether this entry was created by the user locally or shared via the team workspace. */
  kind: "personal" | "team";
  install_state?: "installed" | "pending-secrets" | "conflict";
  conflict_reason?: string;
  /** For team MCPs: env var names the teammate must supply before the MCP can be installed. */
  pending_secrets?: string[];
}

export interface McpManifest {
  version: 5;
  schema_version: 5;
  mcps: Record<string, McpManifestEntry>;
  name_conflicts: Record<string, {
    agents: Agent[];
    resolved: boolean;
    authoritative_agent: Agent | null;
  }>;
}

function getDefaultMcpManifestPath(): string {
  return getMcpManifestPath(getActiveProfile());
}

function emptyMcpManifest(): McpManifest {
  return {
    version: 5,
    schema_version: 5,
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
  const path = manifestPath ?? getDefaultMcpManifestPath();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version === 5 && parsed?.mcps) {
      const manifest = parsed as McpManifest;
      // Normalize: entries missing the kind field default to "personal"
      for (const entry of Object.values(manifest.mcps)) {
        if (!entry.kind) entry.kind = "personal";
      }
      return manifest;
    }
  } catch { /* missing or malformed */ }
  return emptyMcpManifest();
}

/** Atomic write: tmp → rename. */
export function writeMcpManifest(manifest: McpManifest, manifestPath?: string): void {
  const path = manifestPath ?? getDefaultMcpManifestPath();
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
