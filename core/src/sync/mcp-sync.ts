// core/src/sync/mcp-sync.ts — MCP detection, reconcile, and approval

import { createHash } from "crypto";
import { readAgentMcps, writeAgentMcp, removeAgentMcp } from "../agents/mcp";
import {
  readMcpManifest,
  writeMcpManifest,
  tombstoneMcp,
  hashCanonical,
  type Agent,
  type CanonicalMcp,
  type McpManifestEntry,
} from "./manifest";
import { ParseError } from "./atomic-write";
import { isSecretHeader, generateEnvVarName, writeSecretsJson, writeEnvSh, readSecretsJson } from "../secrets";

export type { Agent, CanonicalMcp };

export interface PendingMcpEntry {
  id: string;
  name: string;
  source_agent: Agent;
  config: Record<string, unknown>;
  canonical: CanonicalMcp;
  /** True when both agents have an entry with the same name but different canonical forms. */
  conflict?: boolean;
}

export interface McpConflict {
  name: string;
  "claude-code": { config: Record<string, unknown>; canonical: CanonicalMcp };
  codex: { config: Record<string, unknown>; canonical: CanonicalMcp };
}

export interface McpDriftEntry {
  id: string;
  name: string;
  source_agent: Agent;
  target_agent: Agent;
  expected: CanonicalMcp;
  observed: Record<string, unknown>;
}

export interface McpReconcileResult {
  resynced: string[];
  tombstoned: string[];
  drifted: McpDriftEntry[];
  errors: string[];
}

export interface McpSyncOpts {
  claudeConfigPath?: string;
  codexConfigPath?: string;
  manifestPath?: string;
  statePath?: string;
}

// ── Normalization helpers ──────────────────────────────────────────────────────

/** Convert a Claude Code mcpServers entry to canonical form. Returns null if not HTTP. */
export function fromClaudeCodeEntry(name: string, entry: Record<string, unknown>): CanonicalMcp | null {
  // Claude Code HTTP MCPs have a `url` field
  if (typeof entry["url"] !== "string") return null;
  const canonical: CanonicalMcp = { type: "http", url: entry["url"] as string };

  const rawHeaders = entry["headers"];
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    canonical.headers = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string") {
        const secret = isSecretHeader(k);
        if (secret) {
          const envVar = generateEnvVarName("claude-code", name);
          canonical.headers[k] = { value_env: envVar, secret: true };
        } else {
          canonical.headers[k] = { value_literal: v, secret: false };
        }
      }
    }
  }

  if (typeof entry["disabled"] === "boolean") canonical.disabled = entry["disabled"] as boolean;
  return canonical;
}

/** Convert a Codex config.toml MCP entry to canonical form. Returns null if not HTTP. */
export function fromCodexEntry(name: string, entry: Record<string, unknown>): CanonicalMcp | null {
  // Codex HTTP MCPs have a `url` field
  if (typeof entry["url"] !== "string") return null;
  const canonical: CanonicalMcp = { type: "http", url: entry["url"] as string };

  // Codex uses bearer_token_env_var for Authorization header
  if (typeof entry["bearer_token_env_var"] === "string") {
    canonical.headers = {
      Authorization: { value_env: entry["bearer_token_env_var"] as string, secret: true },
    };
  }

  // Codex uses http_headers for non-secret headers
  const httpHeaders = entry["http_headers"];
  if (httpHeaders && typeof httpHeaders === "object" && !Array.isArray(httpHeaders)) {
    if (!canonical.headers) canonical.headers = {};
    for (const [k, v] of Object.entries(httpHeaders as Record<string, unknown>)) {
      if (typeof v === "string" && k.toLowerCase() !== "authorization") {
        canonical.headers[k] = { value_literal: v, secret: false };
      }
    }
  }

  if (typeof entry["disabled"] === "boolean") canonical.disabled = entry["disabled"] as boolean;
  return canonical;
}

/** Normalize any raw entry to canonical form — ignores agent-specific extra fields. */
export function normalizeSyncCanonical(entry: Record<string, unknown>): CanonicalMcp | null {
  if (typeof entry["url"] !== "string") return null;
  return { type: "http", url: entry["url"] as string };
}

/** Semantic equality — compare sorted JSON representations of canonical MCPs. */
export function semanticEquals(a: CanonicalMcp, b: CanonicalMcp): boolean {
  const sortedStr = (obj: unknown): string => {
    if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(sortedStr).join(",")}]`;
    const sorted = Object.keys(obj as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStr((obj as Record<string, unknown>)[k])}`);
    return `{${sorted.join(",")}}`;
  };
  return sortedStr(a) === sortedStr(b);
}

// ── Agent config entry builders ────────────────────────────────────────────────

/** Build a Claude Code mcpServers entry from canonical form. Writes literal token. */
export function toClaudeCodeEntry(
  canonical: CanonicalMcp,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { url: canonical.url };
  if (canonical.disabled !== undefined) entry["disabled"] = canonical.disabled;
  if (canonical.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(canonical.headers)) {
      if (v.secret && v.value_env) {
        const literal = secrets[v.value_env];
        if (literal) headers[k] = literal;
      } else if (v.value_literal) {
        headers[k] = v.value_literal;
      }
    }
    if (Object.keys(headers).length > 0) entry["headers"] = headers;
  }
  return entry;
}

/** Build a Codex config.toml entry from canonical form. Uses bearer_token_env_var for auth. */
export function toCodexEntry(canonical: CanonicalMcp): Record<string, unknown> {
  const entry: Record<string, unknown> = { url: canonical.url };
  if (canonical.disabled !== undefined) entry["disabled"] = canonical.disabled;
  if (canonical.headers) {
    for (const [k, v] of Object.entries(canonical.headers)) {
      if (k.toLowerCase() === "authorization" && v.secret && v.value_env) {
        entry["bearer_token_env_var"] = v.value_env;
      } else if (!v.secret && v.value_literal) {
        if (!entry["http_headers"]) entry["http_headers"] = {};
        (entry["http_headers"] as Record<string, string>)[k] = v.value_literal;
      }
    }
  }
  return entry;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect MCP entries not yet in the manifest (pending approval).
 * Never writes to the manifest — detection only.
 */
export function detectMcpPending(opts?: McpSyncOpts): {
  pending: PendingMcpEntry[];
  conflicts: McpConflict[];
} {
  const manifest = readMcpManifest(opts?.manifestPath);

  let claudeMcps: Record<string, Record<string, unknown>> = {};
  let codexMcps: Record<string, Record<string, unknown>> = {};

  try { claudeMcps = readAgentMcps("claude-code", opts?.claudeConfigPath); } catch { /* blocked */ }
  try { codexMcps = readAgentMcps("codex", opts?.codexConfigPath); } catch { /* blocked */ }

  const pending: PendingMcpEntry[] = [];
  const conflicts: McpConflict[] = [];
  const conflictedNames = new Set<string>();

  const allNames = new Set([...Object.keys(claudeMcps), ...Object.keys(codexMcps)]);

  for (const name of allNames) {
    const claudeEntry = claudeMcps[name];
    const codexEntry = codexMcps[name];

    const claudeCanonical = claudeEntry ? fromClaudeCodeEntry(name, claudeEntry) : null;
    const codexCanonical = codexEntry ? fromCodexEntry(name, codexEntry) : null;

    // Both agents have this MCP
    if (claudeCanonical && codexCanonical) {
      const claudeId = `claude-code:${name}`;
      const codexId = `codex:${name}`;
      // Actively managed = in manifest and not tombstoned
      const activelyManaged =
        (manifest.mcps[claudeId] && !manifest.mcps[claudeId].removed_at) ||
        (manifest.mcps[codexId] && !manifest.mcps[codexId].removed_at);
      if (activelyManaged) continue;

      if (semanticEquals(claudeCanonical, codexCanonical)) {
        if (!conflictedNames.has(name)) {
          pending.push({ id: claudeId, name, source_agent: "claude-code", config: claudeEntry, canonical: claudeCanonical });
        }
      } else if (!conflictedNames.has(name)) {
        conflictedNames.add(name);
        conflicts.push({
          name,
          "claude-code": { config: claudeEntry, canonical: claudeCanonical },
          codex: { config: codexEntry, canonical: codexCanonical },
        });
      }
      continue;
    }

    // Only Claude Code has this MCP
    if (claudeCanonical) {
      const id = `claude-code:${name}`;
      const activelyManaged = manifest.mcps[id] && !manifest.mcps[id].removed_at;
      if (!activelyManaged) {
        pending.push({ id, name, source_agent: "claude-code", config: claudeEntry, canonical: claudeCanonical });
      }
      continue;
    }

    // Only Codex has this MCP
    if (codexCanonical) {
      const id = `codex:${name}`;
      const activelyManaged = manifest.mcps[id] && !manifest.mcps[id].removed_at;
      if (!activelyManaged) {
        pending.push({ id, name, source_agent: "codex", config: codexEntry, canonical: codexCanonical });
      }
    }
  }

  return { pending, conflicts };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/**
 * Approve pending MCPs — write manifest entries and sync to target agent config.
 * This is the only place manifest entries are created.
 */
export async function approveMcps(
  entries: PendingMcpEntry[],
  opts?: McpSyncOpts,
): Promise<void> {
  const manifest = readMcpManifest(opts?.manifestPath);
  const secrets = readSecretsJson(opts?.statePath);

  for (const entry of entries) {
    const { id, name, source_agent, config: originalConfig, canonical } = entry;
    const targetAgent: Agent = source_agent === "claude-code" ? "codex" : "claude-code";

    // Build env_var_mapping for secret headers
    const envVarMapping: Record<string, string> = {};
    if (canonical.headers) {
      for (const [header, hv] of Object.entries(canonical.headers)) {
        if (hv.secret && hv.value_env) {
          envVarMapping[hv.value_env] = `${header} header`;
        }
      }
    }

    const now = new Date().toISOString();
    const manifestEntry: McpManifestEntry = {
      id,
      name,
      source_agent,
      sync_canonical: canonical,
      sync_canonical_hash: hashCanonical(canonical),
      source_snapshot: { original_config: originalConfig },
      env_var_mapping: envVarMapping,
      synced_to: {},
      removed_at: null,
    };

    // Write to target agent config
    try {
      if (targetAgent === "claude-code") {
        const targetEntry = toClaudeCodeEntry(canonical, secrets);
        await writeAgentMcp("claude-code", name, targetEntry, opts?.claudeConfigPath);
      } else {
        const targetEntry = toCodexEntry(canonical);
        await writeAgentMcp("codex", name, targetEntry, opts?.codexConfigPath);

        // Persist env vars for Codex bearer auth
        const envVarsToWrite: Record<string, string> = {};
        for (const envVar of Object.keys(envVarMapping)) {
          const literal = secrets[envVar];
          if (literal) envVarsToWrite[envVar] = literal;
        }
        if (Object.keys(envVarsToWrite).length > 0) {
          writeEnvSh({ ...secrets, ...envVarsToWrite }, opts?.statePath);
        }
      }

      manifestEntry.synced_to[targetAgent] = { synced_at: now, target_name: name };
    } catch {
      // Partial failure — still write manifest entry without synced_to
    }

    manifest.mcps[id] = manifestEntry;
  }

  writeMcpManifest(manifest, opts?.manifestPath);
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

/**
 * Reconcile manifest entries against observed config state.
 * Called on startup and on config file changes.
 * Processes only approved/synced MCPs (pending entries are handled by detectMcpPending).
 */
export async function reconcile(opts?: McpSyncOpts): Promise<McpReconcileResult> {
  const result: McpReconcileResult = { resynced: [], tombstoned: [], drifted: [], errors: [] };
  const manifest = readMcpManifest(opts?.manifestPath);

  let claudeMcps: Record<string, Record<string, unknown>> = {};
  let codexMcps: Record<string, Record<string, unknown>> = {};
  let claudeBlocked = false;
  let codexBlocked = false;

  try {
    claudeMcps = readAgentMcps("claude-code", opts?.claudeConfigPath);
  } catch (e) {
    if (e instanceof ParseError) claudeBlocked = true;
    else result.errors.push(`Failed to read ~/.claude.json: ${e}`);
  }

  try {
    codexMcps = readAgentMcps("codex", opts?.codexConfigPath);
  } catch (e) {
    if (e instanceof ParseError) codexBlocked = true;
    else result.errors.push(`Failed to read ~/.codex/config.toml: ${e}`);
  }

  const secrets = readSecretsJson(opts?.statePath);

  for (const [id, entry] of Object.entries(manifest.mcps)) {
    if (entry.removed_at) {
      // Tombstoned — remove only from agents Draft wrote to (synced_to), never from source.
      // The source agent's config belongs to the user; Draft should not touch it on removal.
      const syncedAgents = Object.keys(entry.synced_to) as Agent[];
      for (const agent of syncedAgents) {
        if (agent === entry.source_agent) continue; // never remove from source
        if (agent === "claude-code" && claudeBlocked) continue;
        if (agent === "codex" && codexBlocked) continue;
        const observed = (agent === "claude-code" ? claudeMcps : codexMcps)[entry.name];
        if (!observed) continue;

        const observedCanonical = agent === "claude-code"
          ? fromClaudeCodeEntry(entry.name, observed)
          : fromCodexEntry(entry.name, observed);
        if (!observedCanonical) continue;

        const observedHash = hashCanonical(observedCanonical);
        if (observedHash === entry.sync_canonical_hash) {
          try {
            await removeAgentMcp(agent, entry.name, agent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath);
          } catch (e) {
            result.errors.push(`Failed to remove ${entry.name} from ${agent}: ${e}`);
          }
        } else {
          result.errors.push(`${entry.name} in ${agent}: new user-owned entry detected at tombstoned slot — not removing`);
        }
      }
      continue;
    }

    // Active entry — check each agent
    const sourceConfig = entry.source_agent === "claude-code" ? claudeMcps : codexMcps;
    const sourceMcp = sourceConfig[entry.name];

    const sourcePresent = !!sourceMcp;

    for (const targetAgent of ["claude-code", "codex"] as Agent[]) {
      if (targetAgent === "claude-code" && claudeBlocked) continue;
      if (targetAgent === "codex" && codexBlocked) continue;

      const targetConfig = targetAgent === "claude-code" ? claudeMcps : codexMcps;
      const observed = targetConfig[entry.name];

      if (!sourcePresent && !observed) {
        // Both sides gone while daemon was offline — tombstone
        tombstoneMcp(id, opts?.manifestPath);
        result.tombstoned.push(id);
        break;
      }

      if (!sourcePresent && observed) {
        // Source gone, target still present — tombstone + remove from target
        tombstoneMcp(id, opts?.manifestPath);
        result.tombstoned.push(id);
        try {
          await removeAgentMcp(targetAgent, entry.name, targetAgent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath);
        } catch (e) {
          result.errors.push(`Failed to remove ${entry.name} from ${targetAgent}: ${e}`);
        }
        break;
      }

      if (targetAgent === entry.source_agent) continue; // skip self-check

      if (!observed) {
        // Target missing — re-sync
        try {
          const targetEntry = targetAgent === "claude-code"
            ? toClaudeCodeEntry(entry.sync_canonical, secrets)
            : toCodexEntry(entry.sync_canonical);
          await writeAgentMcp(targetAgent, entry.name, targetEntry, targetAgent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath);
          result.resynced.push(id);
          // Update synced_to in manifest
          const updatedManifest = readMcpManifest(opts?.manifestPath);
          if (updatedManifest.mcps[id]) {
            updatedManifest.mcps[id].synced_to[targetAgent] = {
              synced_at: new Date().toISOString(),
              target_name: entry.name,
            };
            writeMcpManifest(updatedManifest, opts?.manifestPath);
          }
        } catch (e) {
          result.errors.push(`Failed to re-sync ${entry.name} to ${targetAgent}: ${e}`);
        }
      } else {
        // Target present — check if it matches canonical
        const observedCanonical = targetAgent === "claude-code"
          ? fromClaudeCodeEntry(entry.name, observed)
          : fromCodexEntry(entry.name, observed);
        if (observedCanonical && !semanticEquals(observedCanonical, entry.sync_canonical)) {
          result.drifted.push({
            id,
            name: entry.name,
            source_agent: entry.source_agent,
            target_agent: targetAgent,
            expected: entry.sync_canonical,
            observed,
          });
        }
      }
    }
  }

  return result;
}
