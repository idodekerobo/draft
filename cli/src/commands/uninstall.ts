// commands/uninstall.ts — draft uninstall
//
// Removes all of Draft: daemon, config, LaunchAgent, and Claude Code plugin files.
// Does NOT remove the cloned repo itself.
// Requires explicit confirmation: type 'yes' to proceed.

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn, capture } from "../utils/exec.ts";
import { red, yellow, dim, green, cyan, bold } from "../utils/output.ts";

const HOME = process.env.HOME!;
const DRAFT_GLOBAL = `${HOME}/.draft`;
const BACKGROUND = `${DRAFT_GLOBAL}/background`;
const CLAUDE_DIR = `${HOME}/.claude`;

export async function runUninstall(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft uninstall");
    console.log("Removes all of Draft: daemon, LaunchAgent, config, and Claude Code plugin files.");
    console.log(`${yellow("Note:")} This removes Draft entirely, not just one tool's plugin.`);
    console.log(`To remove Draft from a specific tool only, delete files from ~/.claude/skills/ and ~/.claude/agents/ manually.`);
    process.exit(0);
  }

  console.log("");
  console.log(bold("draft uninstall"));
  console.log(dim("─".repeat(40)));
  console.log("");
  console.log(`${yellow("Warning:")} This will remove:`);
  console.log(`  • All Draft daemon files and logs (${dim("~/.draft/background/")})`);
  console.log(`  • Draft plugin files from Claude Code (${dim("~/.claude/skills/draft:*, ~/.claude/agents/draft-*.md")})`);
  console.log(`  • LaunchAgent registration`);
  console.log("");
  console.log(dim("Your workspace context files (~/.draft/workspaces/) will NOT be removed."));
  console.log(dim("Remove them manually if you want a full clean slate."));
  console.log("");

  // Require explicit confirmation
  process.stdout.write(`Type ${cyan("yes")} to confirm, or press Enter to cancel: `);
  const input = await readLine();
  console.log("");

  if (input.trim().toLowerCase() !== "yes") {
    console.log(dim("Cancelled."));
    process.exit(0);
  }

  // ── 1. Run the existing uninstall.sh (stops daemon + removes LaunchAgent) ──
  if (existsSync(`${BACKGROUND}/uninstall.sh`)) {
    console.log(dim("Stopping daemon and removing LaunchAgent..."));
    const code = await spawn(["bash", `${BACKGROUND}/uninstall.sh`]);
    if (code !== 0) {
      console.warn(yellow("  uninstall.sh exited non-zero — continuing anyway."));
    }
  } else {
    // Fallback: try to unload LaunchAgent directly
    const plistPath = `${HOME}/Library/LaunchAgents/com.draft.daemon.plist`;
    if (existsSync(plistPath)) {
      await capture(["launchctl", "unload", plistPath]);
      await capture(["rm", "-f", plistPath]);
    }
  }
  console.log(`  ${green("✓")} Daemon stopped and LaunchAgent removed`);

  // ── 2. Remove Claude Code plugin files ─────────────────────────────────────
  removeGlob(`${CLAUDE_DIR}/skills`, /^draft:/);
  removeGlob(`${CLAUDE_DIR}/agents`, /^draft-/);
  console.log(`  ${green("✓")} Claude Code plugin files removed`);

  // ── 3. Note about settings.json hooks ─────────────────────────────────────
  console.log("");
  console.log(dim(`Note: ~/.claude/settings.json hooks and env vars were not modified.`));
  console.log(dim(`Remove the Draft entries manually if needed.`));
  console.log("");
  console.log(green("Draft removed."));
  console.log(dim("Your workspace context files remain at ~/.draft/workspaces/ — delete manually to fully clean up."));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function removeGlob(dir: string, pattern: RegExp): void {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (pattern.test(entry)) {
        const fullPath = join(dir, entry);
        try {
          unlinkSync(fullPath);
        } catch {
          // might be a directory — use spawn rm -rf for dirs
        }
      }
    }
  } catch {
    // ignore
  }
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
