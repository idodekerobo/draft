import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// Local, hand-rolled types/read/write — deliberately decoupled from mcp-sync.ts's
// live McpManifest types (matching 20260709195000_backfill_personal_skill_manifests.ts's
// precedent), so this migration doesn't break if app-code signatures evolve later.

type McpManifestSyncEntryV5 = {
  synced_at: string;
  target_name: string;
};

type CanonicalMcpV5 = {
  type: "http";
  url: string;
  headers?: Record<string, unknown>;
  disabled?: boolean;
};

type McpManifestEntryV5 = {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  sync_canonical: CanonicalMcpV5;
  sync_canonical_hash: string;
  source_snapshot: { original_config: Record<string, unknown> };
  env_var_mapping: Record<string, string>;
  synced_to: Partial<Record<"claude-code" | "codex", McpManifestSyncEntryV5>>;
  removed_at: string | null;
  kind: "personal" | "team";
  install_state?: string;
  conflict_reason?: string;
  pending_secrets?: string[];
};

type McpManifestV5 = {
  version: 5;
  schema_version: 5;
  mcps: Record<string, McpManifestEntryV5>;
  name_conflicts: Record<string, unknown>;
};

function readManifestTolerant(path: string): McpManifestV5 {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema_version === 5 && parsed?.mcps) return parsed as McpManifestV5;
  } catch { /* missing or malformed — treat as empty */ }
  return { version: 5, schema_version: 5, mcps: {}, name_conflicts: {} };
}

function writeManifestAtomic(manifest: McpManifestV5, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Minimal, local read of a target agent's config, top-level scope only.
 *
 * DOCUMENTED LIMITATION: this does not mirror core/src/agents/mcp.ts's
 * readAgentMcps(), which additionally merges Claude Code's project-scoped
 * mcpServers entries. Reimplementing that merge here would mean importing
 * evolving app code — exactly what this migration's hand-roll precedent
 * (matching 20260709195000_backfill_personal_skill_manifests.ts's
 * isOwnedSymlink) exists to avoid. A personal MCP only reachable via a
 * project-scoped entry will not be verified as "live" by this migration and
 * will simply not get backfilled — safe (under-inclusive), never wrong.
 */
function readTopLevelMcpUrl(agent: "claude-code" | "codex", name: string, home: string): string | undefined {
  try {
    if (agent === "claude-code") {
      const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
      const entry = parsed?.mcpServers?.[name];
      return typeof entry?.url === "string" ? entry.url : undefined;
    }
    // Codex: minimal top-level [mcp_servers.<name>] url = "..." scan — no
    // sub-tables, no merging, just enough to verify the canonical url.
    const raw = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headerPattern = new RegExp(`\\[mcp_servers\\."?${escaped}"?\\]([^\\[]*)`, "ms");
    const match = raw.match(headerPattern);
    if (!match) return undefined;
    const urlMatch = match[1]?.match(/^\s*url\s*=\s*"([^"]*)"/m);
    return urlMatch?.[1];
  } catch {
    return undefined;
  }
}

/**
 * DOCUMENTED LIMITATION: verifies liveness by comparing only the canonical
 * `url`, not the full sync_canonical (headers included) — a full
 * reimplementation of fromClaudeCodeEntry/fromCodexEntry's header
 * normalization here would essentially duplicate mcp-sync.ts's logic
 * wholesale. url is the primary identity of an MCP entry; this is a
 * best-effort backfill, not a live-correctness-critical path (the real
 * install/uninstall lifecycle in mcp-sync.ts always does the full check).
 */
function isLiveMatch(entry: McpManifestEntryV5, home: string): boolean {
  const syncEntries = Object.entries(entry.synced_to) as [("claude-code" | "codex"), McpManifestSyncEntryV5][];
  if (syncEntries.length === 0) return false;
  return syncEntries.every(([agent, sync]) => readTopLevelMcpUrl(agent, sync.target_name, home) === entry.sync_canonical.url);
}

/**
 * Backfill every existing profile with approved personal-MCP entries for
 * MCPs currently verified as live (matching the target agent's config) —
 * same reasoning and additive-only guarantees as
 * 20260709195000_backfill_personal_skill_manifests.ts, adapted for MCPs:
 * McpManifestEntry has no filesystem source_path to realpath-compare, so
 * cross-profile conflicts are compared by sync_canonical_hash instead.
 * Personal MCP secrets are global (see mcp-sync.ts's installPersonalMcps
 * doc comment), so — unlike a filesystem symlink — there is no
 * profile-specific secret-availability gate needed here.
 */
export async function migrateBackfillPersonalMcpManifests(home: string = homedir()): Promise<void> {
  const workspacesDir = join(home, ".draft", "workspaces");
  let profiles: string[] = [];
  try {
    profiles = readdirSync(workspacesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  const allApproved = new Map<string, McpManifestEntryV5>();
  const conflicting = new Set<string>();

  for (const profile of profiles) {
    const manifestPath = join(workspacesDir, profile, "config", "mcp-manifest.json");
    const manifest = readManifestTolerant(manifestPath);
    for (const [id, entry] of Object.entries(manifest.mcps)) {
      if (entry.kind !== "personal") continue;
      if (entry.removed_at !== null) continue;
      if (!isLiveMatch(entry, home)) continue;

      const existing = allApproved.get(id);
      // Compared by sync_canonical_hash, not url: two profiles can agree on
      // the url but diverge on headers (e.g. different auth env vars) — that
      // is still a disagreement about the entry's identity, and we must not
      // silently pick whichever profile was scanned first. The hash is
      // already on both entries; nothing to hand-roll. (url-only comparison
      // remains fine for isLiveMatch above — that limitation is documented.)
      if (existing && existing.sync_canonical_hash !== entry.sync_canonical_hash) {
        conflicting.add(id);
        continue;
      }
      allApproved.set(id, entry);
    }
  }
  for (const id of conflicting) allApproved.delete(id);

  for (const profile of profiles) {
    const manifestPath = join(workspacesDir, profile, "config", "mcp-manifest.json");
    const manifest = readManifestTolerant(manifestPath);
    let dirty = false;
    for (const [id, entry] of allApproved) {
      if (manifest.mcps[id]) continue; // any existing opinion wins
      manifest.mcps[id] = { ...entry };
      dirty = true;
    }
    if (dirty) writeManifestAtomic(manifest, manifestPath);
  }
}

export default function migrate(): Promise<void> {
  return migrateBackfillPersonalMcpManifests();
}
