// core/src/scanner.ts — shared scanner for cross-agent skill directories
//
// Used by: draft-desktop, draft-cli
// Scans Claude Code and Codex skill directories, detects Draft-managed skills,
// creates cross-agent symlinks, and manages a registry file.

import { createHash } from "crypto";
import {
  existsSync, readdirSync, readFileSync, lstatSync, statSync, symlinkSync,
  mkdirSync, writeFileSync, readlinkSync, renameSync, unlinkSync, realpathSync,
  cpSync, rmSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { getSkillManifestPath, getActiveProfile } from "./config";

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
  /** Whether this entry was created by the user locally or shared via the team workspace. */
  kind: "personal" | "team";
  install_state?: "installed" | "pending-secrets" | "conflict";
  conflict_reason?: string;
}

export interface SkillManifest {
  version: 5;
  schema_version: 5;
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
const DEFAULT_CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
const DEFAULT_CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const DEFAULT_CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

function getDefaultManifestPath(): string {
  return getSkillManifestPath(getActiveProfile());
}

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
 * the ~/.draft/ directory (team skills, whose source lives in the workspace),
 * or with one of the sibling agent skill directories (personal skills that
 * createSymlinks() mirrors directly between ~/.claude/skills and
 * ~/.codex/skills — these never pass through ~/.draft/, since the symlink
 * points straight at the other agent's real directory). Without the second
 * check, scanSkillDirectories() re-discovers Draft's own cross-agent mirrors
 * as "new" skills on every scan.
 */
export function isDraftManaged(dirPath: string, draftDir?: string, siblingDirs?: string[]): boolean {
  const draft = resolve(draftDir ?? DRAFT_DIR);
  const siblings = (siblingDirs ?? [DEFAULT_CLAUDE_SKILLS_DIR, DEFAULT_CODEX_SKILLS_DIR]).map((d) => resolve(d));
  try {
    const stat = lstatSync(dirPath);
    if (!stat.isSymbolicLink()) return false;
    const target = resolve(join(dirPath, ".."), readlinkSync(dirPath));
    if (target === draft || target.startsWith(`${draft}/`)) return true;
    return siblings.some((dir) => target === dir || target.startsWith(`${dir}/`));
  } catch {
    return false;
  }
}

// ── isBackupDirName ────────────────────────────────────────────────────────────

const BACKUP_DIR_PATTERN = /\.bak$/i;

/** Check if a directory name looks like a backup copy (e.g. "gstack.bak"). */
export function isBackupDirName(name: string): boolean {
  return BACKUP_DIR_PATTERN.test(name);
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
 * Skips Draft-managed skills: symlinks pointing into ~/.draft/ (team skills)
 * or into the sibling agent's skill directory (personal cross-agent mirrors).
 * Also skips backup-style directories (e.g. "*.bak") — stale copies left
 * behind by manual backups or tool upgrades, which would otherwise be mirrored
 * to the sibling agent and double-count every nested sub-skill it contains.
 * Returns metadata for each discovered skill.
 */
export function scanSkillDirectories(opts?: ScanSkillOpts): { skills: ScannedSkill[]; errors: ScanDirError[] } {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  const draftDir = opts?.draftDir ?? DRAFT_DIR;
  const siblingDirs = [claudeDir, codexDir];

  const skills: ScannedSkill[] = [];
  const errors: ScanDirError[] = [];

  const scanDir = (dir: string, agent: Agent) => {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (isDraftManaged(fullPath, draftDir, siblingDirs)) continue;
        if (isBackupDirName(entry.name)) continue;
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
    version: 5,
    schema_version: 5,
    min_reader_version: 1,
    skills: {},
    name_conflicts: {},
  };
}

export function readSkillManifest(manifestPath?: string): SkillManifest {
  const path = manifestPath ?? getDefaultManifestPath();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version === 5) {
      const manifest = parsed as SkillManifest;
      // Normalize: entries missing the kind field default to "personal"
      for (const entry of Object.values(manifest.skills)) {
        if (!entry.kind) entry.kind = "personal";
      }
      return manifest;
    }
  } catch { /* missing or malformed */ }
  return emptyManifest();
}

/** Atomic write of the skill manifest: tmp → rename. */
export function writeSkillManifest(manifest: SkillManifest, manifestPath?: string): void {
  const path = manifestPath ?? getDefaultManifestPath();
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

  // Clean up stale .draft-backup dirs left by interrupted promoteSkillToTeam
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  for (const dir of [claudeDir, codexDir]) {
    try {
      const entries = readdirSync(dir);
      for (const name of entries) {
        if (name.endsWith(".draft-backup")) {
          const backupPath = join(dir, name);
          // Only clean up if the corresponding symlink was successfully created
          const originalName = name.slice(0, -".draft-backup".length);
          const originalPath = join(dir, originalName);
          try {
            const stat = lstatSync(originalPath);
            if (stat.isSymbolicLink()) {
              rmSync(backupPath, { recursive: true, force: true });
            }
          } catch { /* original path doesn't exist — leave backup for manual inspection */ }
        }
      }
    } catch { /* dir doesn't exist or can't be read */ }
  }

  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (entry.removed_at !== null) continue; // tombstoned — skip
    if (entry.status !== "approved") continue; // only reconcile approved entries

    const sourceExists = (() => {
      // Team skills: source_path is a real dir in the workspace (symlinks are allowed targets)
      // User skills: source_path must be a real directory (not a symlink)
      try {
        const s = lstatSync(entry.source_path);
        return entry.kind === "team" ? s.isDirectory() : (!s.isSymbolicLink() && s.isDirectory());
      }
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
  let manifestDirty = false;

  // Load manifest once; we'll update it after all symlink operations
  const manifestPath = opts?.manifestPath ?? getDefaultManifestPath();
  let manifest: SkillManifest;
  try {
    manifest = readSkillManifest(manifestPath);
  } catch {
    manifest = emptyManifest();
  }

  const recordApprovedSkill = (
    skill: ScannedSkill,
    targetAgent: Agent,
    linkPath: string,
    absoluteSource: string,
  ): void => {
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
      kind: existing?.kind ?? "personal",
    };
    manifestDirty = true;
  };

  for (const skill of skills) {
    const targetDir = skill.agent === "claude-code" ? codexDir : claudeDir;
    const targetAgent: Agent = skill.agent === "claude-code" ? "codex" : "claude-code";
    const linkPath = join(targetDir, skill.name);
    const absoluteSource = resolve(skill.dirPath);

    try {
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(absoluteSource, linkPath);

      recordApprovedSkill(skill, targetAgent, linkPath, absoluteSource);
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
              // A symlink can already exist because another profile approved the same
              // personal skill. Record approval in this profile's manifest as well.
              recordApprovedSkill(skill, targetAgent, linkPath, absoluteSource);
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

  if (manifestDirty) {
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
      const manifestPath = opts?.manifestPath ?? getDefaultManifestPath();
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

// ── Team skill management ─────────────────────────────────────────────────────

export interface TeamSkillInput {
  name: string;
  sourcePath: string;
}

export interface InstallTeamSkillsOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
}

export interface InstallTeamSkillsResult {
  installed: string[];
  skipped: string[];
  errors: string[];
  conflicts: Array<{ name: string; reason: "personal-name-collision" | "target-modified" }>;
}

/**
 * Install team skills from workspace into both agent skill directories as symlinks.
 * No approval gate — these were placed in the workspace intentionally by the curator.
 * Writes manifest entries with kind: "team", both synced_to populated.
 */
export function installTeamSkills(
  skills: TeamSkillInput[],
  profile: string,
  opts?: InstallTeamSkillsOpts,
): InstallTeamSkillsResult {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  const manifestPath = opts?.manifestPath ?? getDefaultManifestPath();

  const result: InstallTeamSkillsResult = { installed: [], skipped: [], errors: [], conflicts: [] };
  const manifest = readSkillManifest(manifestPath);
  const now = new Date().toISOString();
  let dirty = false;

  for (const { name, sourcePath } of skills) {
    const absoluteSource = resolve(sourcePath);
    const claudeLinkPath = join(claudeDir, name);
    const codexLinkPath = join(codexDir, name);
    const id = `team:${name}`;

    if (!existsSync(join(absoluteSource, "SKILL.md"))) {
      result.errors.push(`${name}: source skill has no SKILL.md`);
      continue;
    }

    const inspectTarget = (linkPath: string): "missing" | "owned" | "conflict" => {
      try {
        const stat = lstatSync(linkPath);
        if (!stat.isSymbolicLink()) return "conflict";
        const actual = realpathSync(resolve(dirname(linkPath), readlinkSync(linkPath)));
        return actual === realpathSync(absoluteSource) ? "owned" : "conflict";
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "conflict";
      }
    };

    const claudeState = inspectTarget(claudeLinkPath);
    const codexState = inspectTarget(codexLinkPath);
    if (claudeState === "conflict" || codexState === "conflict") {
      const conflictingPaths = [
        ...(claudeState === "conflict" ? [claudeLinkPath] : []),
        ...(codexState === "conflict" ? [codexLinkPath] : []),
      ];
      result.skipped.push(...conflictingPaths);
      result.conflicts.push({ name, reason: "personal-name-collision" });
      manifest.skills[id] = {
        id,
        name,
        source_agent: "claude-code",
        source_path: absoluteSource,
        skill_dir_hash: hashSkillDir(absoluteSource),
        added_at: manifest.skills[id]?.added_at ?? now,
        approved_at: now,
        status: "conflict",
        synced_to: manifest.skills[id]?.synced_to ?? {},
        removed_at: null,
        kind: "team",
        install_state: "conflict",
        conflict_reason: "personal-name-collision",
      };
      dirty = true;
      continue;
    }

    const created: string[] = [];
    try {
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      if (claudeState === "missing") {
        symlinkSync(absoluteSource, claudeLinkPath);
        created.push(claudeLinkPath);
      }
      if (codexState === "missing") {
        symlinkSync(absoluteSource, codexLinkPath);
        created.push(codexLinkPath);
      }
      result.installed.push(name);
      manifest.skills[id] = {
        id,
        name,
        source_agent: "claude-code",
        source_path: absoluteSource,
        skill_dir_hash: hashSkillDir(absoluteSource),
        added_at: manifest.skills[id]?.added_at ?? now,
        approved_at: now,
        status: "approved",
        synced_to: {
          "claude-code": { target_name: name, symlink_path: claudeLinkPath, synced_at: now },
          codex: { target_name: name, symlink_path: codexLinkPath, synced_at: now },
        },
        removed_at: null,
        kind: "team",
        install_state: "installed",
      };
      dirty = true;
    } catch (e) {
      for (const path of created) {
        try { unlinkSync(path); } catch { /* rollback best effort */ }
      }
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (dirty) {
    try { writeSkillManifest(manifest, manifestPath); } catch (e) {
      result.errors.push(`skill manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * Uninstall all team skills belonging to a given profile:
 * removes symlinks from both agent directories and tombstones manifest entries.
 */
export function uninstallTeamSkills(profile: string, opts?: InstallTeamSkillsOpts): InstallTeamSkillsResult {
  return uninstallTeamSkillEntries(profile, undefined, opts);
}

export function uninstallTeamSkill(
  profile: string,
  name: string,
  opts?: InstallTeamSkillsOpts,
): InstallTeamSkillsResult {
  return uninstallTeamSkillEntries(profile, name, opts);
}

function uninstallTeamSkillEntries(
  profile: string,
  name: string | undefined,
  opts?: InstallTeamSkillsOpts,
): InstallTeamSkillsResult {
  const manifestPath = opts?.manifestPath ?? getDefaultManifestPath();
  const manifest = readSkillManifest(manifestPath);
  const result: InstallTeamSkillsResult = { installed: [], skipped: [], errors: [], conflicts: [] };
  let dirty = false;

  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (entry.kind !== "team") continue;
    if (name !== undefined && entry.name !== name) continue;
    if (entry.removed_at !== null) continue;

    for (const syncEntry of Object.values(entry.synced_to)) {
      const { symlink_path } = syncEntry as SkillManifestSyncEntry;
      try {
        const stat = lstatSync(symlink_path);
        if (!stat.isSymbolicLink()) {
          result.conflicts.push({ name: entry.name, reason: "target-modified" });
          continue;
        }
        const actual = realpathSync(resolve(dirname(symlink_path), readlinkSync(symlink_path)));
        const expected = realpathSync(entry.source_path);
        if (actual !== expected) {
          result.conflicts.push({ name: entry.name, reason: "target-modified" });
          continue;
        }
        unlinkSync(symlink_path);
        result.skipped.push(symlink_path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          result.errors.push(`${symlink_path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    manifest.skills[id] = {
      ...entry,
      status: "tombstoned",
      removed_at: new Date().toISOString(),
    };
    dirty = true;
  }

  if (dirty) {
    try { writeSkillManifest(manifest, manifestPath); } catch (e) {
      result.errors.push(`skill manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

export interface PromoteSkillToTeamOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
}

/**
 * Promote a user-owned skill to the team workspace (Flow A).
 *
 * Safe rename-then-symlink sequence:
 *   1. Copy source dir → workspace skills/<name>/ (in a tmp dir first)
 *   2. Verify SKILL.md present in copy
 *   3. Atomic rename copy into final workspace path
 *   4. Rename original source dir to .draft-backup (reversible)
 *   5. Create symlink at original source path → workspace path
 *   6. On failure at step 5: restore backup (no data loss)
 *   7. On success: update Codex symlink, delete backup
 *
 * Stale .draft-backup dirs from crashes are cleaned by reconcileSkillManifest on restart.
 */
export function promoteSkillToTeam(
  skillId: string,
  workspacePath: string,
  profile: string,
  opts?: PromoteSkillToTeamOpts,
): { ok: boolean; error?: string } {
  const manifestPath = opts?.manifestPath ?? getDefaultManifestPath();
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;

  const manifest = readSkillManifest(manifestPath);
  const entry = manifest.skills[skillId];

  if (!entry) return { ok: false, error: `Skill not found: ${skillId}` };
  if (entry.kind === "team") return { ok: false, error: "Skill is already a team skill." };
  if (entry.status !== "approved") return { ok: false, error: "Skill must be approved before promoting to team." };

  const name = entry.name;
  const sourcePath = entry.source_path;
  const teamSkillsDir = join(workspacePath, "skills");
  const finalWorkspacePath = join(teamSkillsDir, name);
  const tmpPath = join(teamSkillsDir, `.draft-promoting-${name}-${Date.now()}`);
  const backupPath = `${sourcePath}.draft-backup`;
  const otherAgent: Agent = entry.source_agent === "claude-code" ? "codex" : "claude-code";
  const otherPath = entry.synced_to[otherAgent]?.symlink_path
    ?? join(otherAgent === "claude-code" ? claudeDir : codexDir, name);

  // Fail fast if workspace destination already exists
  if (existsSync(finalWorkspacePath)) {
    return { ok: false, error: `Team skill already exists at ${finalWorkspacePath}` };
  }
  if (existsSync(otherPath)) {
    try {
      const stat = lstatSync(otherPath);
      const actual = stat.isSymbolicLink()
        ? realpathSync(resolve(dirname(otherPath), readlinkSync(otherPath)))
        : null;
      if (actual !== realpathSync(sourcePath)) {
        return { ok: false, error: `Personal skill collision at ${otherPath}` };
      }
    } catch (e) {
      return { ok: false, error: `Cannot inspect ${otherPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  try {
    mkdirSync(teamSkillsDir, { recursive: true });

    // Step 1: Copy to temp location in workspace
    cpSync(sourcePath, tmpPath, { recursive: true });

    // Step 2: Sanity check
    if (!existsSync(join(tmpPath, "SKILL.md"))) {
      rmSync(tmpPath, { recursive: true, force: true });
      return { ok: false, error: "Source skill dir has no SKILL.md — refusing to promote." };
    }

    // Step 3: Atomic rename into final workspace path
    renameSync(tmpPath, finalWorkspacePath);

    // Step 4: Rename original to backup
    renameSync(sourcePath, backupPath);

    // Step 5: Symlink original path → workspace
    try {
      symlinkSync(resolve(finalWorkspacePath), sourcePath);
    } catch (e) {
      // Recovery: restore backup
      try { renameSync(backupPath, sourcePath); } catch { /* best effort */ }
      try { rmSync(finalWorkspacePath, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, error: `Failed to create symlink: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Step 6: Update the cross-agent symlink to workspace path
    try {
      if (existsSync(otherPath)) {
        const stat = lstatSync(otherPath);
        if (stat.isSymbolicLink()) unlinkSync(otherPath);
      }
      mkdirSync(dirname(otherPath), { recursive: true });
      symlinkSync(resolve(finalWorkspacePath), otherPath);
    } catch (e) {
      try { unlinkSync(sourcePath); } catch { /* best effort */ }
      try { renameSync(backupPath, sourcePath); } catch { /* best effort */ }
      try {
        if (!existsSync(otherPath)) symlinkSync(resolve(sourcePath), otherPath);
      } catch { /* best effort */ }
      try { rmSync(finalWorkspacePath, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, error: `Failed to update cross-agent symlink: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Update manifest entry
    const now = new Date().toISOString();
    const newId = `team:${name}`;
    delete manifest.skills[skillId];
    manifest.skills[newId] = {
      ...entry,
      id: newId,
      source_path: resolve(finalWorkspacePath),
      synced_to: {
        [entry.source_agent]: { target_name: name, symlink_path: sourcePath, synced_at: now },
        [otherAgent]: { target_name: name, symlink_path: otherPath, synced_at: now },
      },
      kind: "team",
      install_state: "installed",
    };
    writeSkillManifest(manifest, manifestPath);
    try { rmSync(backupPath, { recursive: true, force: true }); } catch { /* best effort */ }

    return { ok: true };
  } catch (e) {
    try { if (existsSync(tmpPath)) rmSync(tmpPath, { recursive: true, force: true }); } catch { /* best effort */ }
    if (existsSync(backupPath)) {
      try { if (lstatSync(sourcePath).isSymbolicLink()) unlinkSync(sourcePath); } catch { /* best effort */ }
      try { renameSync(backupPath, sourcePath); } catch { /* best effort */ }
      try {
        if (existsSync(otherPath) && lstatSync(otherPath).isSymbolicLink()) unlinkSync(otherPath);
        symlinkSync(resolve(sourcePath), otherPath);
      } catch { /* best effort */ }
      try { rmSync(finalWorkspacePath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Demote a team-shared skill back to user-owned (Flow A reversal).
 *
 * Reverses promoteSkillToTeam:
 *   1. Remove the symlink at the claude-code skills path
 *   2. Copy the workspace dir back to that path (real directory again)
 *   3. Delete the workspace copy
 *   4. Re-point the codex symlink to the restored claude-code path
 *   5. Revert the manifest entry to user-scoped
 */
export function demoteSkillFromTeam(
  skillId: string,
  opts?: PromoteSkillToTeamOpts,
): { ok: boolean; error?: string } {
  const manifest = readSkillManifest(opts?.manifestPath);
  const entry = manifest.skills[skillId];

  if (!entry) return { ok: false, error: `Skill not found: ${skillId}` };
  if (entry.kind !== "team") return { ok: false, error: "Skill is not a team skill." };

  const name = entry.name;
  const workspaceSkillPath = entry.source_path;
  const sourceSyncEntry = entry.synced_to[entry.source_agent];
  const otherAgent: Agent = entry.source_agent === "claude-code" ? "codex" : "claude-code";
  const otherSyncEntry = entry.synced_to[otherAgent];

  if (!sourceSyncEntry) {
    return { ok: false, error: `No ${entry.source_agent} sync entry — cannot determine original path.` };
  }

  const personalPath = sourceSyncEntry.symlink_path;
  const otherPath = otherSyncEntry?.symlink_path;

  try {
    // Step 1: Remove the symlink at the claude-code path
    try {
      const s = lstatSync(personalPath);
      if (!s.isSymbolicLink() ||
          realpathSync(resolve(dirname(personalPath), readlinkSync(personalPath))) !== realpathSync(workspaceSkillPath)) {
        return { ok: false, error: `Personal replacement at ${personalPath} is not owned by Draft.` };
      }
      unlinkSync(personalPath);
    } catch { /* already gone — continue */ }

    // Step 2: Copy workspace dir back to original claude-code path
    cpSync(workspaceSkillPath, personalPath, { recursive: true });

    // Step 3: Remove workspace copy
    rmSync(workspaceSkillPath, { recursive: true, force: true });

    // Step 4: Re-point codex symlink to the restored claude-code path
    if (otherPath) {
      try {
        const cs = lstatSync(otherPath);
        if (cs.isSymbolicLink() &&
            resolve(dirname(otherPath), readlinkSync(otherPath)) === resolve(workspaceSkillPath)) {
          unlinkSync(otherPath);
        }
      } catch { /* already gone */ }
      try { symlinkSync(resolve(personalPath), otherPath); } catch { /* non-fatal */ }
    }

    // Step 5: Revert manifest entry to user-scoped
    const newId = `${entry.source_agent}:${name}`;
    const now = new Date().toISOString();
    delete manifest.skills[skillId];
    manifest.skills[newId] = {
      ...entry,
      id: newId,
      source_path: personalPath,
      kind: "personal",
      install_state: undefined,
      conflict_reason: undefined,
      synced_to: otherPath
        ? { [otherAgent]: { target_name: name, symlink_path: otherPath, synced_at: now } }
        : {},
    };
    writeSkillManifest(manifest, opts?.manifestPath);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
