// commands/update.ts — draft update
//
// Updates Draft by pulling the latest from the git repo, reinstalling
// bun deps, and re-running `draft add <tool>` for each detected tool install.
//
// Version tracking:
//   ~/.draft/version            — what's currently installed on this machine
//   <repo>/cli-agent-plugin/VERSION  — canonical source version (updated by git pull)
//
// Version file is written AFTER plugin files are re-copied — it reflects
// what's actually installed, not just what's in the repo.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawn, capture } from "../utils/exec.ts";
import { getRepoRoot, getActiveProfile } from "../utils/config.ts";
import { green, red, yellow, dim, bold, cyan } from "../utils/output.ts";
import { installClaudeCode } from "./add.ts";

const HOME = process.env.HOME!;
const VERSION_FILE = `${HOME}/.draft/version`;
const CODEX_HOME = process.env.CODEX_HOME ?? `${HOME}/.codex`;
const CURSOR_HOME = process.env.CURSOR_HOME ?? `${HOME}/.cursor`;

export async function runUpdate(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft update");
    console.log("Pulls the latest Draft from the repo and reinstalls plugin files for all detected tools.");
    console.log("Never touches your workspace context files (~/.draft/workspaces/).");
    process.exit(0);
  }

  const repoRoot = getRepoRoot();

  // ── 1. Read installed version ────────────────────────────────────────────────
  const installedVersion = readInstalledVersion();
  console.log("");
  console.log(`${bold("Draft update")}  ${dim(`(currently v${installedVersion})`)}`);
  console.log(dim("─".repeat(40)));
  console.log("");

  // ── 2. git pull ──────────────────────────────────────────────────────────────
  console.log(dim("Pulling latest from repo..."));
  const pullResult = await capture(
    ["git", "-C", repoRoot, "pull", "origin", "main"],
    { timeoutMs: 30_000 }
  );

  if (pullResult.exitCode !== 0) {
    console.error(red("Update failed: could not pull from remote."));
    console.error(dim(pullResult.stderr || pullResult.stdout));
    console.error(dim("Check your connection, or run `git pull` manually in the repo."));
    process.exit(3);
  }

  // Print git output (shows "Already up to date." or the files changed)
  if (pullResult.stdout) console.log(dim(pullResult.stdout));

  // ── 3. Read new version from repo ───────────────────────────────────────────
  const repoVersionFile = join(repoRoot, "cli-agent-plugin", "VERSION");
  const repoVersion = readFileSync(repoVersionFile, "utf8").trim();

  if (installedVersion === repoVersion) {
    console.log(green(`Already up to date (v${installedVersion}).`));
    process.exit(0);
  }

  console.log(`${dim("Updating:")} v${installedVersion} → ${bold("v" + repoVersion)}`);
  console.log("");

  // ── 4. Update bun deps ───────────────────────────────────────────────────────
  console.log(dim("Updating dependencies..."));
  const bunResult = await capture(
    ["bun", "install", "--cwd", join(repoRoot, "cli")],
    { timeoutMs: 60_000 }
  );
  if (bunResult.exitCode !== 0) {
    console.warn(yellow("  Warning: bun install failed — continuing anyway."));
    console.warn(dim(bunResult.stderr));
  } else {
    console.log(`  ${green("✓")} Dependencies updated`);
  }

  // ── 5. Detect installed tools and reinstall ──────────────────────────────────
  console.log("");
  console.log(dim("Reinstalling plugin files for detected tools..."));

  let anyToolUpdated = false;

  // Claude Code: check for installed skills
  const claudeSkillsDir = `${HOME}/.claude/skills`;
  if (existsSync(claudeSkillsDir) && hasAnyEntry(claudeSkillsDir, /^draft/)) {
    console.log(dim("  Updating claude-code..."));
    try {
      await installClaudeCode(getActiveProfile());
      console.log(`  ${green("✓")} claude-code updated`);
      anyToolUpdated = true;
    } catch (err) {
      console.warn(`  ${yellow("⚠")}  claude-code update failed — run \`draft add claude-code\` manually`);
    }
  }

  // Codex: check for installed hook
  const codexHookFile = `${CODEX_HOME}/hooks/draft/inject-context.sh`;
  if (existsSync(codexHookFile)) {
    console.log(dim("  Updating codex..."));
    const setupScript = join(repoRoot, "cli-agent-plugin", "scripts", "codex-setup.sh");
    const result = await capture(["bash", setupScript], { timeoutMs: 60_000 });
    if (result.exitCode === 0) {
      console.log(`  ${green("✓")} codex updated`);
      anyToolUpdated = true;
    } else {
      console.warn(`  ${yellow("⚠")}  codex update failed — run \`draft add codex\` manually`);
    }
  }

  // Cursor: check for installed hook
  const cursorHookFile = `${CURSOR_HOME}/hooks/draft/cursor-session-start.sh`;
  if (existsSync(cursorHookFile)) {
    console.log(dim("  Updating cursor..."));
    const setupScript = join(repoRoot, "cli-agent-plugin", "scripts", "cursor-setup.sh");
    const result = await capture(["bash", setupScript], { timeoutMs: 60_000 });
    if (result.exitCode === 0) {
      console.log(`  ${green("✓")} cursor updated`);
      anyToolUpdated = true;
    } else {
      console.warn(`  ${yellow("⚠")}  cursor update failed — run \`draft add cursor\` manually`);
    }
  }

  if (!anyToolUpdated) {
    console.log(dim("  No tools detected — run `draft add <tool>` to install."));
  }

  // ── 6. Write new version ─────────────────────────────────────────────────────
  writeFileSync(VERSION_FILE, repoVersion, "utf8");

  // ── 7. Summary ───────────────────────────────────────────────────────────────
  console.log("");
  console.log(dim("─".repeat(40)));
  console.log(`${green("✓")} Draft updated to ${bold("v" + repoVersion)}.`);
  console.log(dim("Restart your tools to apply changes."));
  console.log("");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readInstalledVersion(): string {
  try {
    return readFileSync(VERSION_FILE, "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function hasAnyEntry(dir: string, pattern: RegExp): boolean {
  try {
    return readdirSync(dir).some((f) => pattern.test(f));
  } catch {
    return false;
  }
}
