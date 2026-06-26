// core/src/scanner.ts — shared scanner for cross-agent skill directories
//
// Used by: draft-desktop, draft-cli
// Scans Claude Code and Codex skill directories, detects Draft-managed skills,
// creates cross-agent symlinks, and manages a registry file.

import { createHash } from "crypto";
import {
  existsSync, readdirSync, readFileSync, lstatSync, statSync, symlinkSync,
  mkdirSync, writeFileSync, readlinkSync, renameSync, unlinkSync, realpathSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Agent = "claude-code" | "codex";

export interface ScannedSkill {
  name: string;
  agent: Agent;
  dirPath: string;
  files: string[];
  description: string;
  descriptionTokenCount: number;
  tokenCount: number;
}

export interface ScannedMCP {
  name: string;
  agent: Agent;
  config: Record<string, unknown>;
}

export interface SymlinkConflict {
  linkPath: string;
  actual: string | null;
  expected: string;
}

export interface SymlinkResult {
  created: string[];
  skipped: string[];
  errors: string[];
  conflicts: SymlinkConflict[];
}

// ── Skill Manifest v4 types ────────────────────────────────────────────────────

export interface SkillManifestSyncEntry {
  target_name: string;
  symlink_path: string;
  synced_at: string;
}

export interface SkillManifestEntry {
  id: string;
  name: string;
  source_agent: Agent;
  source_path: string;
  skill_dir_hash: string;
  added_at: string;
  approved_at: string | null;
  status: "pending" | "approved" | "conflict" | "tombstoned";
  synced_to: Partial<Record<Agent, SkillManifestSyncEntry>>;
  removed_at: string | null;
}

export interface SkillManifest {
  version: 4;
  schema_version: 4;
  min_reader_version: 1;
  skills: Record<string, SkillManifestEntry>;
  name_conflicts: Record<string, {
    agents: Agent[];
    resolved: boolean;
    authoritative_agent: Agent | null;
  }>;
}

export interface PendingSkillEntry {
  id: string;
  name: string;
  source_agent: Agent;
  source_path: string;
  skill_dir_hash: string;
  description: string;
  tokenCount: number;
}

export interface SameNameConflict {
  name: string;
  "claude-code": { path: string; skill_dir_hash: string };
  codex: { path: string; skill_dir_hash: string };
}

export interface ReconcileResult {
  repaired: string[];
  tombstoned: string[];
  orphaned: string[];
  conflicts: string[];
}

// ── Path defaults ──────────────────────────────────────────────────────────────

const DRAFT_DIR = join(homedir(), ".draft");
const STATE_DIR = join(DRAFT_DIR, "state");
const DEFAULT_CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
const DEFAULT_CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const DEFAULT_CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const DEFAULT_MANIFEST_PATH = join(STATE_DIR, "skill-manifest.json");

// ── Options interfaces ─────────────────────────────────────────────────────────

export interface ScanSkillOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  draftDir?: string;
}

export interface ScanMCPOpts {
  claudeConfigPath?: string;
  codexConfigPath?: string;
}

export interface ScanResult {
  skills: ScannedSkill[];
  mcpServers: ScannedMCP[];
  errors: ScanDirError[];
}

export interface ScanDirError {
  dir: string;
  agent: Agent;
  message: string;
}

export interface CreateSymlinksOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
}

// ── isDraftManaged ─────────────────────────────────────────────────────────────

/**
 * Check if a directory path is a symlink whose resolved target starts with
 * the ~/.draft/ directory.
 */
export function isDraftManaged(dirPath: string, draftDir?: string): boolean {
  const draft = resolve(draftDir ?? DRAFT_DIR);
  try {
    const stat = lstatSync(dirPath);
    if (!stat.isSymbolicLink()) return false;
    const target = resolve(join(dirPath, ".."), readlinkSync(dirPath));
    return target === draft || target.startsWith(`${draft}/`);
  } catch {
    return false;
  }
}

// ── Frontmatter parser ────────────────────────────────────────────────────────

function parseSkillFrontmatter(content: string): { description: string } {
  if (!content.startsWith("---")) return { description: "" };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { description: "" };
  const frontmatter = content.slice(3, end);
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  let desc = match?.[1]?.trim() ?? "";
  if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
    desc = desc.slice(1, -1);
  }
  return { description: desc };
}

// ── hashSkillDir ───────────────────────────────────────────────────────────────

/**
 * Compute a stable fingerprint of a skill directory: sorted file list +
 * per-file size + content hash. Used for rename detection.
 */
export function hashSkillDir(dirPath: string): string {
  try {
    const files = readdirSync(dirPath).filter((f) => {
      try { return statSync(join(dirPath, f)).isFile(); } catch { return false; }
    }).sort();

    if (files.length === 0) return "sha256:empty";

    const outer = createHash("sha256");
    for (const file of files) {
      try {
        const content = readFileSync(join(dirPath, file));
        const fileHash = createHash("sha256").update(content).digest("hex");
        outer.update(`${file}:${content.length}:${fileHash}\n`);
      } catch { /* skip unreadable files */ }
    }
    return `sha256:${outer.digest("hex")}`;
  } catch {
    return "sha256:empty";
  }
}

// ── scanSkillDirectories ───────────────────────────────────────────────────────

/**
 * Scan ~/.claude/skills/ and ~/.codex/skills/ for skill directories.
 * Skips Draft-managed skills (symlinks pointing into ~/.draft/).
 * Returns metadata for each discovered skill.
 */
export function scanSkillDirectories(opts?: ScanSkillOpts): { skills: ScannedSkill[]; errors: ScanDirError[] } {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  const draftDir = opts?.draftDir ?? DRAFT_DIR;

  const skills: ScannedSkill[] = [];
  const errors: ScanDirError[] = [];

  const scanDir = (dir: string, agent: Agent) => {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (isDraftManaged(fullPath, draftDir)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.isSymbolicLink()) {
          try {
            const resolved = resolve(join(dir), readlinkSync(fullPath));
            if (!existsSync(resolved)) continue;
            const stat = lstatSync(resolved);
            if (!stat.isDirectory()) continue;
          } catch {
            continue;
          }
        }

        try {
          const files = readdirSync(fullPath).filter((f) => {
            try {
              const fPath = join(fullPath, f);
              const s = statSync(fPath);
              return s.isFile();
            } catch {
              return false;
            }
          });

          let totalChars = 0;
          let description = "";
          let descriptionChars = 0;
          const skillFile = join(fullPath, "SKILL.md");
          try {
            const content = readFileSync(skillFile, "utf8");
            totalChars = content.length;
            const parsed = parseSkillFrontmatter(content);
            description = parsed.description;
            descriptionChars = parsed.description.length;
          } catch { /* no SKILL.md or unreadable */ }

          skills.push({
            name: entry.name, agent, dirPath: fullPath, files, description,
            descriptionTokenCount: Math.ceil(descriptionChars / 4),
            tokenCount: Math.ceil(totalChars / 4),
          });
        } catch { /* skip dirs we can't read */ }
      }
    } catch (err) {
      errors.push({ dir, agent, message: err instanceof Error ? err.message : String(err) });
    }
  };

  scanDir(claudeDir, "claude-code");
  scanDir(codexDir, "codex");

  return { skills, errors };
}

/**
 * Combined scan: skills + MCP servers + errors in one call.
 */
export function scanAll(opts?: ScanSkillOpts & ScanMCPOpts): ScanResult {
  const { skills, errors } = scanSkillDirectories(opts);
  const mcpServers = scanMCPConnections(opts);
  return { skills, mcpServers, errors };
}

// ── scanMCPConnections ─────────────────────────────────────────────────────────

/**
 * Read ~/.claude.json and extract mcpServers entries.
 * Also reads Codex config.toml [mcp_servers] if present.
 * Returns empty array if files are missing or malformed.
 */
export function scanMCPConnections(opts?: ScanMCPOpts): ScannedMCP[] {
  const results: ScannedMCP[] = [];

  // Claude Code: ~/.claude.json → mcpServers object
  const claudeConfig = opts?.claudeConfigPath ?? DEFAULT_CLAUDE_CONFIG_PATH;
  try {
    const raw = readFileSync(claudeConfig, "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const [name, config] of Object.entries(servers)) {
        results.push({ name, agent: "claude-code", config: config as Record<string, unknown> });
      }
    }
  } catch { /* missing or malformed — skip */ }

  // Codex: ~/.codex/config.toml → [mcp_servers.<name>] sections
  const codexConfig = opts?.codexConfigPath ?? DEFAULT_CODEX_CONFIG_PATH;
  try {
    const raw = readFileSync(codexConfig, "utf8");
    const mcpEntries = parseTOMLMCPServers(raw);
    for (const [name, config] of Object.entries(mcpEntries)) {
      results.push({ name, agent: "codex", config });
    }
  } catch { /* missing or malformed — skip */ }

  return results;
}

/**
 * Minimal TOML parser for [mcp_servers.<name>] sections in Codex config.
 * Handles: strings, booleans, numbers, arrays, and inline tables.
 * Also handles nested sub-tables like [mcp_servers.<name>.env].
 */
function parseTOMLMCPServers(raw: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentServer: string | null = null;
  let currentSubKey: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // [mcp_servers.name.subkey] — nested sub-table (e.g. env)
    const subTableMatch = trimmed.match(/^\[mcp_servers\.([^.\]]+)\.([^\]]+)\]$/);
    if (subTableMatch) {
      currentServer = subTableMatch[1] ?? null;
      currentSubKey = subTableMatch[2] ?? null;
      if (currentServer) {
        if (!result[currentServer]) result[currentServer] = {};
        const serverEntry = result[currentServer];
        if (serverEntry && currentSubKey && !serverEntry[currentSubKey]) {
          serverEntry[currentSubKey] = {};
        }
      }
      continue;
    }

    // [mcp_servers.name] — top-level server table
    const headerMatch = trimmed.match(/^\[mcp_servers\.([^\].]+)\]$/);
    if (headerMatch) {
      currentServer = headerMatch[1] ?? null;
      currentSubKey = null;
      if (currentServer && !result[currentServer]) result[currentServer] = {};
      continue;
    }

    // Any other section header ends the current mcp_servers block
    if (trimmed.startsWith("[")) {
      currentServer = null;
      currentSubKey = null;
      continue;
    }

    if (currentServer) {
      const serverEntry = result[currentServer];
      if (!serverEntry) continue;
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
      if (kvMatch) {
        const key = (kvMatch[1] ?? "").trim();
        const rawValue = (kvMatch[2] ?? "").trim();
        if (!key) continue;
        const value = parseTOMLValue(rawValue);
        if (currentSubKey) {
          const subEntry = serverEntry[currentSubKey] as Record<string, unknown> | undefined;
          if (subEntry) subEntry[key] = value;
        } else {
          serverEntry[key] = value;
        }
      }
    }
  }

  return result;
}

function parseTOMLValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (!isNaN(Number(raw)) && raw !== "") return Number(raw);

  // Array: ["a", "b"]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  // Inline table: { key = "value", key2 = "value2" }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    for (const pair of inner.split(",")) {
      const m = pair.trim().match(/^"?([^"=]+)"?\s*=\s*(.+)$/);
      if (m) {
        const k = (m[1] ?? "").trim();
        const v = (m[2] ?? "").trim();
        if (k) obj[k] = parseTOMLValue(v);
      }
    }
    return obj;
  }

  return raw;
}

// ── Skill Manifest v4 ─────────────────────────────────────────────────────────

function emptyManifest(): SkillManifest {
  return {
    version: 4,
    schema_version: 4,
    min_reader_version: 1,
    skills: {},
    name_conflicts: {},
  };
}

export function readSkillManifest(manifestPath?: string): SkillManifest {
  const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version === 4) return parsed as SkillManifest;
  } catch { /* missing or malformed */ }
  return emptyManifest();
}

/** Atomic write of the skill manifest: tmp → rename. */
export function writeSkillManifest(manifest: SkillManifest, manifestPath?: string): void {
  const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// ── detectPending ─────────────────────────────────────────────────────────────

/**
 * Find skills that are new real directories not yet tracked in the v4 manifest.
 * Returns pending entries (safe to sync after approval) and same-name conflicts
 * (both agents have a real directory with the same name — needs user resolution).
 */
export function detectPending(opts?: ScanSkillOpts & { manifestPath?: string }): {
  pending: PendingSkillEntry[];
  conflicts: SameNameConflict[];
} {
  const manifest = readSkillManifest(opts?.manifestPath);
  const { skills } = scanSkillDirectories(opts);

  // Collect only real directories (not symlinks) from each agent
  const claudeRealDirs = new Map<string, ScannedSkill>();
  const codexRealDirs = new Map<string, ScannedSkill>();

  for (const skill of skills) {
    try {
      const stat = lstatSync(skill.dirPath);
      if (!stat.isSymbolicLink()) {
        if (skill.agent === "claude-code") claudeRealDirs.set(skill.name, skill);
        else codexRealDirs.set(skill.name, skill);
      }
    } catch { /* skip */ }
  }

  const pending: PendingSkillEntry[] = [];
  const conflicts: SameNameConflict[] = [];
  const conflictedNames = new Set<string>();

  const check = (realDirs: Map<string, ScannedSkill>, agent: Agent) => {
    const otherAgent: Agent = agent === "claude-code" ? "codex" : "claude-code";
    const otherDirs = otherAgent === "claude-code" ? claudeRealDirs : codexRealDirs;

    for (const [name, skill] of realDirs) {
      const id = `${agent}:${name}`;
      if (manifest.skills[id]) continue; // already tracked
      // Skip names where conflict was already resolved (keep-local or pick-source)
      if (manifest.name_conflicts[name]?.resolved) continue;

      const otherSkill = otherDirs.get(name);
      if (otherSkill && !conflictedNames.has(name)) {
        conflictedNames.add(name);
        conflicts.push({
          name,
          "claude-code": {
            path: agent === "claude-code" ? skill.dirPath : otherSkill.dirPath,
            skill_dir_hash: hashSkillDir(agent === "claude-code" ? skill.dirPath : otherSkill.dirPath),
          },
          codex: {
            path: agent === "codex" ? skill.dirPath : otherSkill.dirPath,
            skill_dir_hash: hashSkillDir(agent === "codex" ? skill.dirPath : otherSkill.dirPath),
          },
        });
      } else if (!otherSkill) {
        pending.push({
          id,
          name,
          source_agent: agent,
          source_path: skill.dirPath,
          skill_dir_hash: hashSkillDir(skill.dirPath),
          description: skill.description,
          tokenCount: skill.tokenCount,
        });
      }
    }
  };

  check(claudeRealDirs, "claude-code");
  check(codexRealDirs, "codex");

  return { pending, conflicts };
}

// ── reconcileSkillManifest ────────────────────────────────────────────────────

/**
 * Verify all approved manifest entries against the filesystem. Re-creates
 * missing symlinks (crash recovery), tombstones entries where both sides are
 * gone, and surfaces orphaned/conflicted symlinks for user review.
 */
export function reconcileSkillManifest(opts?: ScanSkillOpts & { manifestPath?: string }): ReconcileResult {
  const result: ReconcileResult = { repaired: [], tombstoned: [], orphaned: [], conflicts: [] };
  const manifest = readSkillManifest(opts?.manifestPath);
  const updated: SkillManifest = { ...manifest, skills: { ...manifest.skills } };
  let dirty = false;

  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (entry.removed_at !== null) continue; // tombstoned — skip
    if (entry.status !== "approved") continue; // only reconcile approved entries

    const sourceExists = (() => {
      try { const s = lstatSync(entry.source_path); return !s.isSymbolicLink() && s.isDirectory(); }
      catch { return false; }
    })();

    for (const [targetAgent, syncEntry] of Object.entries(entry.synced_to) as [string, SkillManifestSyncEntry][]) {
      const { symlink_path } = syncEntry;

      const symlinkStat = (() => {
        try { return lstatSync(symlink_path); } catch { return null; }
      })();

      const symlinkExists = symlinkStat !== null;
      const symlinkCorrect = (() => {
        if (!symlinkExists || !symlinkStat!.isSymbolicLink()) return false;
        try {
          const actual = realpathSync(resolve(dirname(symlink_path), readlinkSync(symlink_path)));
          const expected = realpathSync(entry.source_path);
          return actual === expected;
        } catch { return false; }
      })();

      if (!sourceExists && !symlinkExists) {
        // Both sides gone — tombstone
        updated.skills[id] = { ...entry, removed_at: new Date().toISOString(), status: "tombstoned" };
        result.tombstoned.push(id);
        dirty = true;
      } else if (sourceExists && !symlinkExists) {
        // Crash recovery — re-create symlink
        try {
          mkdirSync(dirname(symlink_path), { recursive: true });
          symlinkSync(resolve(entry.source_path), symlink_path);
          result.repaired.push(symlink_path);
          updated.skills[id] = {
            ...entry,
            synced_to: {
              ...entry.synced_to,
              [targetAgent]: { ...syncEntry, synced_at: new Date().toISOString() },
            },
          };
          dirty = true;
        } catch (e) {
          result.conflicts.push(`${symlink_path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (!sourceExists && symlinkExists) {
        // Source is gone but symlink remains — needs user action
        result.orphaned.push(symlink_path);
      } else if (symlinkExists && !symlinkCorrect) {
        // Symlink points to unexpected target — surface to user
        result.conflicts.push(`${symlink_path}: points to unexpected target`);
      }
      // else: healthy — no-op
    }
  }

  if (dirty) {
    try { writeSkillManifest(updated, opts?.manifestPath); } catch { /* best effort */ }
  }

  return result;
}

// ── createSymlinks ─────────────────────────────────────────────────────────────

/**
 * For each skill, create an absolute symlink in the opposite agent's skill directory.
 * Claude Code skills get symlinked into Codex, and vice versa.
 * EEXIST-safe: resolves realpath to detect whether an existing entry is already
 * correct (→ skipped) or points elsewhere (→ conflict). Returns a summary.
 */
export function createSymlinks(skills: ScannedSkill[], opts?: CreateSymlinksOpts): SymlinkResult {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;

  const result: SymlinkResult = { created: [], skipped: [], errors: [], conflicts: [] };

  const now = new Date().toISOString();

  // Load v4 manifest once; we'll update it after all symlink operations
  const manifestPath = opts?.manifestPath ?? DEFAULT_MANIFEST_PATH;
  let manifest: SkillManifest;
  try {
    manifest = readSkillManifest(manifestPath);
  } catch {
    manifest = emptyManifest();
  }

  for (const skill of skills) {
    const targetDir = skill.agent === "claude-code" ? codexDir : claudeDir;
    const targetAgent: Agent = skill.agent === "claude-code" ? "codex" : "claude-code";
    const linkPath = join(targetDir, skill.name);
    const absoluteSource = resolve(skill.dirPath);

    try {
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(absoluteSource, linkPath);

      // Symlink created — add to v4 manifest
      const id = `${skill.agent}:${skill.name}`;
      const existing = manifest.skills[id];
      manifest.skills[id] = {
        id,
        name: skill.name,
        source_agent: skill.agent,
        source_path: absoluteSource,
        skill_dir_hash: hashSkillDir(absoluteSource),
        added_at: existing?.added_at ?? now,
        approved_at: now,
        status: "approved",
        synced_to: {
          ...(existing?.synced_to ?? {}),
          [targetAgent]: {
            target_name: skill.name,
            symlink_path: linkPath,
            synced_at: now,
          },
        },
        removed_at: null,
      };
      result.created.push(linkPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        try {
          const stat = lstatSync(linkPath);
          if (stat.isSymbolicLink()) {
            const actual = realpathSync(resolve(dirname(linkPath), readlinkSync(linkPath)));
            const expected = realpathSync(absoluteSource);
            if (actual === expected) {
              result.skipped.push(linkPath);
            } else {
              result.conflicts.push({ linkPath, actual, expected });
            }
          } else {
            // Real directory at target path — conflict
            result.conflicts.push({ linkPath, actual: null, expected: absoluteSource });
          }
        } catch {
          result.errors.push(`${linkPath}: could not inspect existing entry`);
        }
      } else {
        result.errors.push(`${linkPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (result.created.length > 0) {
    try {
      writeSkillManifest(manifest, manifestPath);
    } catch (err) {
      result.errors.push(`skill manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ── removeSymlinks ────────────────────────────────────────────────────────────

export interface RemoveSymlinksResult {
  removed: string[];
  notFound: string[];
  errors: string[];
}

export function removeSymlinks(skills: ScannedSkill[], opts?: CreateSymlinksOpts): RemoveSymlinksResult {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;

  const result: RemoveSymlinksResult = { removed: [], notFound: [], errors: [] };

  for (const skill of skills) {
    const targetDir = skill.agent === "claude-code" ? codexDir : claudeDir;
    const linkPath = join(targetDir, skill.name);

    try {
      if (!existsSync(linkPath)) {
        result.notFound.push(linkPath);
        continue;
      }
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        result.errors.push(`${linkPath}: not a symlink — refusing to delete`);
        continue;
      }
      unlinkSync(linkPath);
      result.removed.push(linkPath);
    } catch (err) {
      result.errors.push(`${linkPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.removed.length > 0) {
    try {
      const manifestPath = opts?.manifestPath ?? DEFAULT_MANIFEST_PATH;
      const manifest = readSkillManifest(manifestPath);
      let dirty = false;
      for (const skill of skills) {
        const id = `${skill.agent}:${skill.name}`;
        if (manifest.skills[id]) {
          delete manifest.skills[id];
          dirty = true;
        }
      }
      if (dirty) writeSkillManifest(manifest, manifestPath);
    } catch (err) {
      result.errors.push(`skill manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

