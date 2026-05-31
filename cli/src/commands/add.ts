// commands/add.ts — draft add <tool>
//
// Supported tools: claude-code, codex, cursor
//
// For claude-code: fully inline TypeScript — no claude-setup.sh exists.
//   1. Bootstrap daemon (run install.sh if not yet installed)
//   2. Resolve or prompt for profile name (first install only)
//   3. Copy skills → ~/.claude/skills/
//   4. Copy agents (all 4) → ~/.claude/agents/
//   5. Copy workspace-template/CLAUDE.md → ~/.draft/workspaces/<profile>/CLAUDE.md
//   6. Merge ~/.claude/settings.json: agent, env, hooks, permissions
//
// For codex/cursor: spawn the existing bash setup scripts.

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "../utils/exec.ts";
import { getRepoRoot } from "../utils/config.ts";
import { writeToolConfig } from "../utils/config.ts";
import { green, red, yellow, bold, cyan, dim } from "../utils/output.ts";

const HOME = process.env.HOME!;
const DRAFT_GLOBAL = `${HOME}/.draft`;
const ACTIVE_PROFILE_FILE = `${DRAFT_GLOBAL}/active-profile`;
const BACKGROUND_INSTALLED = `${DRAFT_GLOBAL}/background`;
const CLAUDE_DIR = `${HOME}/.claude`;

const SUPPORTED_TOOLS = ["claude-code", "codex", "cursor"];

export async function runAdd(args: string[]): Promise<void> {
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: draft add <tool>");
    console.log(`Supported tools: ${SUPPORTED_TOOLS.join(", ")}`);
    console.log("");
    console.log("Adds Draft to a CLI tool — installs skills, agents, and wires hooks.");
    console.log("Safe to re-run after updates (idempotent).");
    process.exit(args.length === 0 ? 1 : 0);
  }

  const tool = args[0].toLowerCase();

  if (!SUPPORTED_TOOLS.includes(tool)) {
    console.error(red(`Unknown tool: ${tool}`));
    console.error(`Supported tools: ${SUPPORTED_TOOLS.join(", ")}`);
    process.exit(1);
  }

  // ── Bootstrap: ensure daemon is installed ───────────────────────────────────
  await bootstrapDaemon();

  // ── Tool-specific install ───────────────────────────────────────────────────
  if (tool === "claude-code") {
    const profileName = await resolveOrPromptProfile();
    await installClaudeCode(profileName);
  } else if (tool === "codex") {
    const repoRoot = getRepoRoot();
    const setupScript = join(repoRoot, "cli-agent-plugin", "scripts", "codex-setup.sh");
    const code = await spawn(["bash", setupScript]);
    process.exit(code);
  } else if (tool === "cursor") {
    const repoRoot = getRepoRoot();
    const setupScript = join(repoRoot, "cli-agent-plugin", "scripts", "cursor-setup.sh");
    const code = await spawn(["bash", setupScript]);
    process.exit(code);
  }
}

// ── Bootstrap daemon ───────────────────────────────────────────────────────────

async function bootstrapDaemon(): Promise<void> {
  if (existsSync(BACKGROUND_INSTALLED)) {
    return; // already installed
  }
  console.log(dim("Installing Draft daemon..."));
  const repoRoot = getRepoRoot();
  const installScript = join(repoRoot, "background", "install.sh");
  const code = await spawn(["bash", installScript]);
  if (code !== 0) {
    console.error(red("Daemon installation failed. Check the output above for details."));
    process.exit(3);
  }
}

// ── Profile resolution ─────────────────────────────────────────────────────────
// On first install (no active-profile file), prompts the user to name their workspace.
// On re-runs or if an active profile already exists, returns that name silently.

async function resolveOrPromptProfile(): Promise<string> {
  if (existsSync(ACTIVE_PROFILE_FILE)) {
    const existing = readFileSync(ACTIVE_PROFILE_FILE, "utf8").trim();
    if (existing) return existing;
  }

  // First install: ask for a workspace name
  console.log("");
  process.stdout.write(`  Name your workspace ${dim("(e.g. acme, my-startup)")} ${dim("[press Enter for 'default']:")} `);
  const input = (await readLine()).trim();
  const profileName = input || "default";

  ensureDir(DRAFT_GLOBAL);
  writeFileSync(ACTIVE_PROFILE_FILE, profileName + "\n");
  return profileName;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.includes("\n")) {
        process.stdin.pause();
        resolve(input.split("\n")[0]);
      }
    });
  });
}

// ── Claude Code install ────────────────────────────────────────────────────────

export async function installClaudeCode(profileName: string): Promise<void> {
  const repoRoot = getRepoRoot();
  const pluginRoot = join(repoRoot, "cli-agent-plugin");

  console.log(dim(`Using plugin root: ${pluginRoot}`));
  console.log("");

  // 1. Copy skills → ~/.claude/skills/
  const skillsSrc = join(pluginRoot, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");
  ensureDir(skillsDst);
  cpSync(skillsSrc, skillsDst, { recursive: true });
  console.log(`  ${green("✓")} Skills copied to ${dim("~/.claude/skills/")}`);

  // 2. Copy agents → ~/.claude/agents/
  const agentsSrc = join(pluginRoot, "agents");
  const agentsDst = join(CLAUDE_DIR, "agents");
  ensureDir(agentsDst);
  cpSync(agentsSrc, agentsDst, { recursive: true });
  console.log(`  ${green("✓")} Agents copied to ${dim("~/.claude/agents/")}`);

  // 3. Copy workspace-template/CLAUDE.md → ~/.draft/workspaces/<profileName>/CLAUDE.md
  const templateSrc = join(pluginRoot, "workspace-template", "CLAUDE.md");
  const workspacePath = `${DRAFT_GLOBAL}/workspaces/${profileName}`;
  ensureDir(workspacePath);
  const templateDst = join(workspacePath, "CLAUDE.md");
  cpSync(templateSrc, templateDst);
  console.log(`  ${green("✓")} Workspace created at ${dim(`~/.draft/workspaces/${profileName}/`)}`);

  // 4. Merge ~/.claude/settings.json
  await mergeClaudeSettings(repoRoot, pluginRoot, workspacePath);
  console.log(`  ${green("✓")} ~/.claude/settings.json updated`);

  // 5. Register in global tool config registry
  writeToolConfig("claude-code", {
    added_at: new Date().toISOString(),
    plugin_root: pluginRoot,
  });
  console.log(`  ${green("✓")} Registered in ~/.draft/config.json`);

  console.log("");
  console.log(`${bold(`Draft added to Claude Code`)} ${dim(`(profile: ${profileName})`)}.`);
  console.log(`Restart Claude Code to activate — then run ${cyan("/draft:setup")} to initialize your workspace.`);
}

// ── Settings merge ─────────────────────────────────────────────────────────────

interface ClaudeSettings {
  agent?: string;
  env?: Record<string, string>;
  hooks?: Record<string, unknown>;
  permissions?: {
    allow?: string[];
    deny?: string[];
    additionalDirectories?: string[];
  };
  [key: string]: unknown;
}

interface PluginHooks {
  hooks: Record<string, unknown>;
}

async function mergeClaudeSettings(repoRoot: string, pluginRoot: string, workspacePath: string): Promise<void> {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  ensureDir(CLAUDE_DIR);

  // Read existing settings (or start fresh)
  let existing: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.warn(yellow(`  Warning: existing settings.json could not be parsed — creating fresh.`));
    }
  }

  // Read hooks from plugin
  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  let pluginHooks: PluginHooks = { hooks: {} };
  if (existsSync(hooksPath)) {
    try {
      pluginHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch {
      console.warn(yellow(`  Warning: could not read hooks.json — hooks not wired.`));
    }
  }

  // Build merged settings
  const merged: ClaudeSettings = {
    ...existing,

    // Primary agent: make draft-agent drive every session
    agent: "draft:draft-agent",

    // Environment variables
    env: {
      ...(existing.env ?? {}),
      DRAFT_WORKSPACE: workspacePath,
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: workspacePath,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },

    // Session hooks from hooks.json
    hooks: {
      ...(existing.hooks ?? {}),
      ...pluginHooks.hooks,
    },

    // Permissions — merge allow list without duplicates
    permissions: {
      ...(existing.permissions ?? {}),
      allow: dedup([
        ...(existing.permissions?.allow ?? []),
        `Write(${DRAFT_GLOBAL}/**)`,
        `Read(${DRAFT_GLOBAL}/**)`,
        `Edit(${DRAFT_GLOBAL}/**)`,
      ]),
      additionalDirectories: dedup([
        ...(existing.permissions?.additionalDirectories ?? []),
        DRAFT_GLOBAL,
        workspacePath,
      ]),
    },
  };

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}
