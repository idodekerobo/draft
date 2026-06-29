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
import { readWorkspaceMcpManifest, writeWorkspaceMcpManifest, type WorkspaceMcpEntry } from "./workspace-mcp";
import { ParseError } from "./atomic-write";
import { isSecretHeader, generateEnvVarName, writeSecretsJson, writeEnvSh, readSecretsJson } from "../secrets";

export type { WorkspaceMcpEntry };

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

function nativeEntryEquals(
  agent: Agent,
  observed: Record<string, unknown>,
  canonical: CanonicalMcp,
  secrets: Record<string, string>,
): boolean {
  const expected = agent === "claude-code"
    ? toClaudeCodeEntry(canonical, secrets)
    : toCodexEntry(canonical);
  const sorted = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
    return `{${Object.keys(value as object).sort()
      .map((key) => `${JSON.stringify(key)}:${sorted((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  };
  return sorted(observed) === sorted(expected);
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
  const activeTeamNames = new Set(
    Object.values(manifest.mcps)
      .filter((entry) => entry.source === "team" && !entry.removed_at)
      .map((entry) => entry.name),
  );

  for (const name of allNames) {
    if (activeTeamNames.has(name)) continue;
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
          pending.push({ id: claudeId, name, source_agent: "claude-code", config: claudeEntry!, canonical: claudeCanonical });
        }
      } else if (!conflictedNames.has(name)) {
        conflictedNames.add(name);
        conflicts.push({
          name,
          "claude-code": { config: claudeEntry!, canonical: claudeCanonical },
          codex: { config: codexEntry!, canonical: codexCanonical },
        });
      }
      continue;
    }

    // Only Claude Code has this MCP
    if (claudeCanonical) {
      const id = `claude-code:${name}`;
      const activelyManaged = manifest.mcps[id] && !manifest.mcps[id].removed_at;
      if (!activelyManaged) {
        pending.push({ id, name, source_agent: "claude-code", config: claudeEntry!, canonical: claudeCanonical });
      }
      continue;
    }

    // Only Codex has this MCP
    if (codexCanonical) {
      const id = `codex:${name}`;
      const activelyManaged = manifest.mcps[id] && !manifest.mcps[id].removed_at;
      if (!activelyManaged) {
        pending.push({ id, name, source_agent: "codex", config: codexEntry!, canonical: codexCanonical });
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
      source: "user",
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

    if (entry.source === "team") {
      if (entry.install_state === "conflict") continue;
      const missingSecrets = (entry.pending_secrets ?? []).filter((env) => !secrets[env]);
      if (missingSecrets.length > 0) continue;
      for (const targetAgent of ["claude-code", "codex"] as Agent[]) {
        if (targetAgent === "claude-code" && claudeBlocked) continue;
        if (targetAgent === "codex" && codexBlocked) continue;
        const targetConfig = targetAgent === "claude-code" ? claudeMcps : codexMcps;
        const observed = targetConfig[entry.name];
        if (!observed) {
          try {
            await writeAgentMcp(
              targetAgent,
              entry.name,
              targetAgent === "claude-code"
                ? toClaudeCodeEntry(entry.sync_canonical, secrets)
                : toCodexEntry(entry.sync_canonical),
              targetAgent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath,
            );
            result.resynced.push(id);
          } catch (e) {
            result.errors.push(`Failed to re-sync ${entry.name} to ${targetAgent}: ${e}`);
          }
          continue;
        }
        if (!nativeEntryEquals(targetAgent, observed, entry.sync_canonical, secrets)) {
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

// ── Team MCP management ───────────────────────────────────────────────────────

export interface InstallTeamMcpsResult {
  installed: string[];
  installed_targets: Array<{ name: string; agent: Agent }>;
  missing_secrets: Array<{ name: string; required_secrets: string[] }>;
  conflicts: Array<{ name: string; reason: "personal-name-collision" | "target-modified" }>;
  errors: string[];
}

/**
 * Install team MCPs from the workspace manifest into both agent configs.
 * MCPs with missing secrets get manifest entries with pending_secrets set;
 * they are written to agent configs once the user supplies the secrets via setMcpSecret.
 */
export async function installTeamMcps(
  entries: WorkspaceMcpEntry[],
  workspacePath: string,
  profile: string,
  opts?: McpSyncOpts,
): Promise<InstallTeamMcpsResult> {
  const result: InstallTeamMcpsResult = {
    installed: [],
    installed_targets: [],
    missing_secrets: [],
    conflicts: [],
    errors: [],
  };
  const manifest = readMcpManifest(opts?.manifestPath);
  const secrets = readSecretsJson(opts?.statePath);
  const now = new Date().toISOString();
  let claudeMcps: Record<string, Record<string, unknown>> = {};
  let codexMcps: Record<string, Record<string, unknown>> = {};
  try { claudeMcps = readAgentMcps("claude-code", opts?.claudeConfigPath); } catch (e) {
    result.errors.push(`Failed to read Claude Code MCPs: ${e}`);
  }
  try { codexMcps = readAgentMcps("codex", opts?.codexConfigPath); } catch (e) {
    result.errors.push(`Failed to read Codex MCPs: ${e}`);
  }

  for (const wsEntry of entries) {
    const { name, canonical, required_secrets } = wsEntry;
    const id = `team:${profile}:${name}`;

    // Check which secrets are missing
    const missingSecs = required_secrets.filter((envVar) => !secrets[envVar]);

    const manifestEntry: McpManifestEntry = {
      id,
      name,
      source_agent: "claude-code",
      sync_canonical: canonical,
      sync_canonical_hash: hashCanonical(canonical),
      source_snapshot: { original_config: {} },
      env_var_mapping: Object.fromEntries(required_secrets.map((s) => [s, `${name} token`])),
      synced_to: {},
      removed_at: null,
      source: "team",
      profile,
      pending_secrets: missingSecs.length > 0 ? missingSecs : undefined,
      install_state: missingSecs.length > 0 ? "pending-secrets" : "installed",
    };

    const previous = manifest.mcps[id];
    const targetIsOwned = (agent: Agent, observed: Record<string, unknown> | undefined): boolean => {
      if (!observed) return true;
      if (!previous || previous.removed_at || previous.source !== "team") return false;
      return nativeEntryEquals(agent, observed, previous.sync_canonical, secrets);
    };
    if (!targetIsOwned("claude-code", claudeMcps[name]) || !targetIsOwned("codex", codexMcps[name])) {
      manifestEntry.install_state = "conflict";
      manifestEntry.conflict_reason = "personal-name-collision";
      manifestEntry.pending_secrets = undefined;
      manifestEntry.synced_to = previous?.synced_to ?? {};
      manifest.mcps[id] = manifestEntry;
      result.conflicts.push({ name, reason: "personal-name-collision" });
      continue;
    }

    if (missingSecs.length > 0) {
      result.missing_secrets.push({ name, required_secrets: missingSecs });
      manifest.mcps[id] = manifestEntry;
      continue;
    }

    // All secrets present — write to both agent configs
    try {
      const claudeEntry = toClaudeCodeEntry(canonical, secrets);
      await writeAgentMcp("claude-code", name, claudeEntry, opts?.claudeConfigPath);
      manifestEntry.synced_to["claude-code"] = { synced_at: now, target_name: name };
      result.installed_targets.push({ name, agent: "claude-code" });
    } catch (e) {
      result.errors.push(`${name} → claude-code: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const codexEntry = toCodexEntry(canonical);
      await writeAgentMcp("codex", name, codexEntry, opts?.codexConfigPath);
      manifestEntry.synced_to["codex"] = { synced_at: now, target_name: name };
      result.installed_targets.push({ name, agent: "codex" });
    } catch (e) {
      result.errors.push(`${name} → codex: ${e instanceof Error ? e.message : String(e)}`);
    }

    manifest.mcps[id] = manifestEntry;
    if (Object.keys(manifestEntry.synced_to).length === 2) result.installed.push(name);
  }

  writeMcpManifest(manifest, opts?.manifestPath);
  return result;
}

/**
 * Uninstall all team MCPs for a given profile:
 * removes from both agent configs and tombstones manifest entries.
 */
export async function uninstallTeamMcps(profile: string, opts?: McpSyncOpts): Promise<InstallTeamMcpsResult> {
  return uninstallTeamMcpEntries(profile, undefined, opts);
}

export async function uninstallTeamMcp(
  profile: string,
  name: string,
  opts?: McpSyncOpts,
): Promise<InstallTeamMcpsResult> {
  return uninstallTeamMcpEntries(profile, name, opts);
}

async function uninstallTeamMcpEntries(
  profile: string,
  name: string | undefined,
  opts?: McpSyncOpts,
): Promise<InstallTeamMcpsResult> {
  const result: InstallTeamMcpsResult = {
    installed: [], installed_targets: [], missing_secrets: [], conflicts: [], errors: [],
  };
  const manifest = readMcpManifest(opts?.manifestPath);
  const secrets = readSecretsJson(opts?.statePath);
  const prefix = `team:${profile}:`;

  for (const [id, entry] of Object.entries(manifest.mcps)) {
    if (!id.startsWith(prefix)) continue;
    if (name !== undefined && entry.name !== name) continue;
    if (entry.removed_at !== null) continue;

    for (const agent of Object.keys(entry.synced_to) as Agent[]) {
      try {
        const observed = readAgentMcps(
          agent,
          agent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath,
        )[entry.name];
        if (!observed) continue;
        if (!nativeEntryEquals(agent, observed, entry.sync_canonical, secrets)) {
          result.conflicts.push({ name: entry.name, reason: "target-modified" });
          continue;
        }
        await removeAgentMcp(agent, entry.name, agent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath);
        result.installed_targets.push({ name: entry.name, agent });
      } catch (e) {
        result.errors.push(`${entry.name} → ${agent}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    manifest.mcps[id] = { ...entry, removed_at: new Date().toISOString() };
  }

  writeMcpManifest(manifest, opts?.manifestPath);
  return result;
}

/**
 * Promote a user-owned MCP to the team workspace (Flow A).
 * Builds a WorkspaceMcpEntry from the manifest entry (secrets stripped —
 * sync_canonical uses value_env refs, not literals) and appends to workspace mcp.json.
 */
export function promoteMcpToTeam(
  mcpId: string,
  workspacePath: string,
  profile: string,
  opts?: McpSyncOpts,
): { ok: boolean; error?: string } {
  const manifest = readMcpManifest(opts?.manifestPath);
  const entry = manifest.mcps[mcpId];

  if (!entry) return { ok: false, error: `MCP not found: ${mcpId}` };
  if (entry.source === "team") return { ok: false, error: "MCP is already a team MCP." };
  if (entry.removed_at) return { ok: false, error: "MCP is tombstoned." };

  const wsManifest = readWorkspaceMcpManifest(workspacePath);

  // Check if already present
  if (wsManifest.servers.find((s) => s.name === entry.name)) {
    return { ok: false, error: `${entry.name} is already in the team workspace MCP list.` };
  }

  // Build required_secrets from env_var_mapping (keys are env var names)
  const required_secrets = Object.keys(entry.env_var_mapping);

  const wsEntry: WorkspaceMcpEntry = {
    name: entry.name,
    canonical: entry.sync_canonical,
    required_secrets,
    description: `From ${entry.source_agent}`,
  };

  wsManifest.servers.push(wsEntry);
  writeWorkspaceMcpManifest(workspacePath, wsManifest);

  // Update manifest entry to team-sourced
  const newId = `team:${profile}:${entry.name}`;
  delete manifest.mcps[mcpId];
  manifest.mcps[newId] = {
    ...entry,
    id: newId,
    source: "team",
    profile,
    install_state: "installed",
  };
  writeMcpManifest(manifest, opts?.manifestPath);

  return { ok: true };
}

/**
 * Demote a team-shared MCP back to user-owned (Flow A reversal).
 *
 * Removes the server from the workspace config/mcp.json and reverts the
 * manifest entry source back to "user" so the item appears as a personal MCP
 * again (with Remove + Share with team buttons in the UI).
 */
export function demoteMcpFromTeam(
  mcpId: string,
  workspacePath: string,
  opts?: McpSyncOpts,
): { ok: boolean; error?: string } {
  const manifest = readMcpManifest(opts?.manifestPath);
  const entry = manifest.mcps[mcpId];

  if (!entry) return { ok: false, error: `MCP not found: ${mcpId}` };
  if (entry.source !== "team") return { ok: false, error: "MCP is not a team MCP." };
  if (entry.removed_at) return { ok: false, error: "MCP is tombstoned." };

  // Remove from workspace config/mcp.json (the team-shared file)
  const wsManifest = readWorkspaceMcpManifest(workspacePath);
  wsManifest.servers = wsManifest.servers.filter((s) => s.name !== entry.name);
  writeWorkspaceMcpManifest(workspacePath, wsManifest);

  // Revert manifest entry to user-scoped — id format matches user entries
  const newId = `${entry.source_agent}:${entry.name}`;
  delete manifest.mcps[mcpId];
  manifest.mcps[newId] = {
    ...entry,
    id: newId,
    source: "user",
    profile: undefined,
    install_state: undefined,
    conflict_reason: undefined,
    pending_secrets: undefined,
  };
  writeMcpManifest(manifest, opts?.manifestPath);

  return { ok: true };
}

/**
 * Set a secret for a team MCP that was blocked on missing credentials.
 * Writes the secret to secrets.json, then re-attempts to write the MCP to agent configs.
 */
export async function setTeamMcpSecret(
  mcpName: string,
  profile: string,
  envVar: string,
  value: string,
  opts?: McpSyncOpts,
): Promise<{ ok: boolean; error?: string; nowInstalled: boolean }> {
  const manifest = readMcpManifest(opts?.manifestPath);
  const id = `team:${profile}:${mcpName}`;
  const entry = manifest.mcps[id];

  if (!entry) return { ok: false, error: `Team MCP not found: ${mcpName}`, nowInstalled: false };

  // Write secret to secrets.json
  const secrets = readSecretsJson(opts?.statePath);
  secrets[envVar] = value;
  writeSecretsJson(secrets, opts?.statePath);

  // Check if all secrets are now present
  const stillMissing = (entry.pending_secrets ?? []).filter((s) => s !== envVar && !secrets[s]);
  if (stillMissing.length > 0) {
    // Update pending_secrets list
    manifest.mcps[id] = { ...entry, pending_secrets: stillMissing, install_state: "pending-secrets" };
    writeMcpManifest(manifest, opts?.manifestPath);
    return { ok: true, nowInstalled: false };
  }

  // All secrets present — install to both agents
  const now = new Date().toISOString();
  const updated = {
    ...entry,
    pending_secrets: undefined,
    install_state: "installed" as const,
    conflict_reason: undefined,
    synced_to: { ...entry.synced_to },
  };

  for (const agent of ["claude-code", "codex"] as Agent[]) {
    try {
      const observed = readAgentMcps(
        agent,
        agent === "claude-code" ? opts?.claudeConfigPath : opts?.codexConfigPath,
      )[mcpName];
      if (observed && !nativeEntryEquals(agent, observed, entry.sync_canonical, secrets)) {
        manifest.mcps[id] = {
          ...entry,
          install_state: "conflict",
          conflict_reason: "personal-name-collision",
          pending_secrets: undefined,
        };
        writeMcpManifest(manifest, opts?.manifestPath);
        return { ok: false, error: `${mcpName} conflicts with a personal ${agent} MCP`, nowInstalled: false };
      }
    } catch (e) {
      return { ok: false, error: `Failed to inspect ${agent}: ${e instanceof Error ? e.message : String(e)}`, nowInstalled: false };
    }
  }

  try {
    const claudeEntry = toClaudeCodeEntry(entry.sync_canonical, secrets);
    await writeAgentMcp("claude-code", mcpName, claudeEntry, opts?.claudeConfigPath);
    updated.synced_to["claude-code"] = { synced_at: now, target_name: mcpName };
  } catch (e) {
    return { ok: false, error: `Failed to write to Claude Code: ${e instanceof Error ? e.message : String(e)}`, nowInstalled: false };
  }

  try {
    const codexEntry = toCodexEntry(entry.sync_canonical);
    await writeAgentMcp("codex", mcpName, codexEntry, opts?.codexConfigPath);
    updated.synced_to["codex"] = { synced_at: now, target_name: mcpName };
  } catch (e) {
    return { ok: false, error: `Failed to write to Codex: ${e instanceof Error ? e.message : String(e)}`, nowInstalled: false };
  }

  manifest.mcps[id] = updated;
  writeMcpManifest(manifest, opts?.manifestPath);

  return { ok: true, nowInstalled: true };
}
