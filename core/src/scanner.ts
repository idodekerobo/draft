// core/src/scanner.ts — shared scanner for cross-agent skill directories
//
// Used by: draft-desktop, draft-cli
// Scans Claude Code and Codex skill directories, detects Draft-managed skills,
// creates cross-agent symlinks, and manages a registry file.

import { existsSync, readdirSync, readFileSync, lstatSync, symlinkSync, mkdirSync, writeFileSync, readlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScannedSkill {
  name: string;
  agent: "claude-code" | "codex";
  dirPath: string;
  files: string[];
  tokenCount: number;
}

export interface ScannedMCP {
  name: string;
  agent: "claude-code" | "codex";
  config: Record<string, unknown>;
}

export interface SkillRegistry {
  skills: ScannedSkill[];
  mcpConnections: ScannedMCP[];
  lastScan: string;
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
const DEFAULT_REGISTRY_PATH = join(DRAFT_DIR, "background", "state", "registry.json");

// ── Options interfaces ─────────────────────────────────────────────────────────

export interface ScanSkillOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  draftDir?: string;
}

export interface ScanMCPOpts {
  claudeConfigPath?: string;
}

export interface CreateSymlinksOpts {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
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

// ── scanSkillDirectories ───────────────────────────────────────────────────────

/**
 * Scan ~/.claude/skills/ and ~/.codex/skills/ for skill directories.
 * Skips Draft-managed skills (symlinks pointing into ~/.draft/).
 * Returns metadata for each discovered skill.
 */
export function scanSkillDirectories(opts?: ScanSkillOpts): ScannedSkill[] {
  const claudeDir = opts?.claudeSkillsDir ?? DEFAULT_CLAUDE_SKILLS_DIR;
  const codexDir = opts?.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  const draftDir = opts?.draftDir ?? DRAFT_DIR;

  const skills: ScannedSkill[] = [];

  const scanDir = (dir: string, agent: "claude-code" | "codex") => {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        // Skip Draft-managed symlinks
        if (isDraftManaged(fullPath, draftDir)) continue;
        // Only process directories (or symlinks to directories)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        // For symlinks that aren't Draft-managed, check if they resolve to a dir
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
              const s = lstatSync(fPath);
              return s.isFile();
            } catch {
              return false;
            }
          });

          let totalChars = 0;
          for (const f of files) {
            try {
              const content = readFileSync(join(fullPath, f), "utf8");
              totalChars += content.length;
            } catch {
              // skip unreadable files
            }
          }

          skills.push({
            name: entry.name,
            agent,
            dirPath: fullPath,
            files,
            tokenCount: Math.ceil(totalChars / 4),
          });
        } catch {
          // skip dirs we can't read
        }
      }
    } catch {
      // dir unreadable — return nothing
    }
  };

  scanDir(claudeDir, "claude-code");
  scanDir(codexDir, "codex");

  return skills;
}

// ── scanMCPConnections ─────────────────────────────────────────────────────────

/**
 * Read ~/.claude.json and extract mcpServers entries.
 * Returns empty array if the file is missing or malformed.
 */
export function scanMCPConnections(opts?: ScanMCPOpts): ScannedMCP[] {
  const configPath = opts?.claudeConfigPath ?? DEFAULT_CLAUDE_CONFIG_PATH;

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return [];

    const results: ScannedMCP[] = [];
    for (const [name, config] of Object.entries(servers)) {
      results.push({
        name,
        agent: "claude-code",
        config: config as Record<string, unknown>,
      });
    }
    return results;
  } catch {
    return [];
  }
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

  return result;
}

// ── Registry ───────────────────────────────────────────────────────────────────

/**
 * Read the skill registry from disk.
 * Returns null if the file is missing or malformed.
 */
export function readRegistry(registryPath?: string): SkillRegistry | null {
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as SkillRegistry;
  } catch {
    return null;
  }
}

/**
 * Write the skill registry to disk. Creates parent directories if needed.
 */
export function writeRegistry(registry: SkillRegistry, registryPath?: string): void {
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;
  const parentDir = path.slice(0, path.lastIndexOf("/"));
  if (parentDir) mkdirSync(parentDir, { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
}
