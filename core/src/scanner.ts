// core/src/scanner.ts — shared scanner for cross-agent skill directories
//
// Used by: draft-desktop, draft-cli
// Scans Claude Code and Codex skill directories, detects Draft-managed skills,
// creates cross-agent symlinks, and manages a registry file.

import { existsSync, readdirSync, readFileSync, lstatSync, statSync, symlinkSync, mkdirSync, writeFileSync, readlinkSync, renameSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScannedSkill {
  name: string;
  agent: "claude-code" | "codex";
  dirPath: string;
  files: string[];
  description: string;
  descriptionTokenCount: number;
  tokenCount: number;
}

export interface ScannedMCP {
  name: string;
  agent: "claude-code" | "codex";
  config: Record<string, unknown>;
}

export interface SymlinkResult {
  created: string[];
  skipped: string[];
  errors: string[];
}

// ── Path defaults ──────────────────────────────────────────────────────────────

const DRAFT_DIR = join(homedir(), ".draft");
const DEFAULT_CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
const DEFAULT_CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const DEFAULT_CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const LEGACY_MANIFEST_PATH = join(DRAFT_DIR, "skill-manifest.json");
const DEFAULT_MANIFEST_PATH = join(DRAFT_DIR, "shared", "skill-manifest.json");

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
  agent: "claude-code" | "codex";
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

  const scanDir = (dir: string, agent: "claude-code" | "codex") => {
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
      currentServer = subTableMatch[1];
      currentSubKey = subTableMatch[2];
      if (!result[currentServer]) result[currentServer] = {};
      if (!result[currentServer][currentSubKey]) result[currentServer][currentSubKey] = {};
      continue;
    }

    // [mcp_servers.name] — top-level server table
    const headerMatch = trimmed.match(/^\[mcp_servers\.([^\].]+)\]$/);
    if (headerMatch) {
      currentServer = headerMatch[1];
      currentSubKey = null;
      if (!result[currentServer]) result[currentServer] = {};
      continue;
    }

    // Any other section header ends the current mcp_servers block
    if (trimmed.startsWith("[")) {
      currentServer = null;
      currentSubKey = null;
      continue;
    }

    if (currentServer) {
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const rawValue = kvMatch[2].trim();
        const value = parseTOMLValue(rawValue);
        if (currentSubKey) {
          (result[currentServer][currentSubKey] as Record<string, unknown>)[key] = value;
        } else {
          result[currentServer][key] = value;
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
      if (m) obj[m[1].trim()] = parseTOMLValue(m[2].trim());
    }
    return obj;
  }

  return raw;
}

// ── createSymlinks ─────────────────────────────────────────────────────────────

/**
 * For each skill, create a symlink in the opposite agent's skill directory.
 * Claude Code skills get symlinked into Codex, and vice versa.
 * Skips if the target already exists. Returns a summary of actions taken.
 */
export function createSymlinks(skills: ScannedSkill[], opts?: CreateSymlinksOpts): SymlinkResult {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;

  const result: SymlinkResult = { created: [], skipped: [], errors: [] };

  for (const skill of skills) {
    const targetDir = skill.agent === "claude-code" ? codexDir : claudeDir;
    const linkPath = join(targetDir, skill.name);

    try {
      if (existsSync(linkPath)) {
        result.skipped.push(linkPath);
        continue;
      }
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(skill.dirPath, linkPath);
      result.created.push(linkPath);
    } catch (err) {
      result.errors.push(`${linkPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.created.length > 0) {
    try {
      updateSkillManifest(result.created, opts?.manifestPath);
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
      pruneSkillManifest(result.removed, opts?.manifestPath);
    } catch (err) {
      result.errors.push(`skill manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ── Skill manifest ────────────────────────────────────────────────────────────

/** Read Draft-created symlink paths for cleanup. Malformed or missing manifests are empty. */
export function readSkillManifest(manifestPath?: string): string[] {
  const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
  const fallback = !manifestPath && !existsSync(path) ? LEGACY_MANIFEST_PATH : null;
  const readPath = fallback && existsSync(fallback) ? fallback : path;
  try {
    const raw = readFileSync(readPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Merge newly-created symlink paths into the shared cleanup manifest. */
export function updateSkillManifest(paths: string[], manifestPath?: string): void {
  const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
  const parentDir = path.slice(0, path.lastIndexOf("/"));
  if (parentDir) mkdirSync(parentDir, { recursive: true });

  let existing = readSkillManifest(path);

  if (!manifestPath && existsSync(LEGACY_MANIFEST_PATH) && LEGACY_MANIFEST_PATH !== path) {
    const legacy = readSkillManifest(LEGACY_MANIFEST_PATH);
    existing = [...new Set([...existing, ...legacy])];
    try { unlinkSync(LEGACY_MANIFEST_PATH); } catch {}
  }

  const merged = [...new Set([...existing, ...paths])];
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}

/** Remove paths from the skill manifest after symlinks are deleted. */
export function pruneSkillManifest(removedPaths: string[], manifestPath?: string): void {
  const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
  const existing = readSkillManifest(path);
  const removeSet = new Set(removedPaths);
  const pruned = existing.filter((entry) => !removeSet.has(entry));
  if (pruned.length === existing.length) return;
  const parentDir = path.slice(0, path.lastIndexOf("/"));
  if (parentDir) mkdirSync(parentDir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(pruned, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}
