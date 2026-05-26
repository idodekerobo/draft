// commands/sync.ts — draft publish + draft load

import { existsSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { spawn, capture } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath, readCollaboration } from "../utils/config.ts";
import { green, red, yellow, dim, cyan, bold } from "../utils/output.ts";

const HOME = process.env.HOME!;
const BACKGROUND = `${HOME}/.draft/background`;

// ── publish ────────────────────────────────────────────────────────────────────

export async function runPublish(_args: string[]): Promise<void> {
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  // 1. Check collaboration is configured
  const collabResult = readCollaboration(workspace);
  if (!collabResult.ok) {
    console.error(red("No team repo configured."));
    console.error(dim("Run /draft:setup-collab in Claude Code first."));
    process.exit(2);
  }

  // 2. Get gh username
  const ghResult = await capture(["gh", "api", "user", "--jq", ".login"]);
  if (ghResult.exitCode !== 0 || !ghResult.stdout.trim()) {
    console.error(red("GitHub CLI not authenticated."));
    console.error(`Run ${cyan("gh auth login")} first.`);
    process.exit(3);
  }
  const ghUsername = ghResult.stdout.trim();

  // 3. Scan accepted/ for pending proposals
  const acceptedDir = join(workspace, "accepted");
  if (!existsSync(acceptedDir)) {
    console.log(dim("Nothing to publish."));
    process.exit(0);
  }

  const files = readdirSync(acceptedDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, path: join(acceptedDir, f), mtime: statSync(join(acceptedDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime); // oldest first

  if (files.length === 0) {
    console.log(dim("Nothing to publish."));
    process.exit(0);
  }

  console.log(`Publishing ${bold(String(files.length))} proposal(s)...`);
  console.log("");

  // 4. Commit each proposal
  const commitScript = join(BACKGROUND, "commit-to-team-context.sh");
  let published = 0;

  for (const file of files) {
    const result = await capture(
      ["bash", commitScript, file.path, workspace, ghUsername],
      { timeoutMs: 60_000 }
    );

    if (result.exitCode === 0) {
      unlinkSync(file.path);
      published++;
      console.log(`  ${green("✓")} ${file.name}`);
    } else {
      console.error(`  ${red("✗")} ${file.name}`);
      console.error(dim(result.stderr || result.stdout));
      console.error("");
      console.error(yellow(`Stopped after ${published} published. Remaining files left in accepted/.`));
      console.error(dim(`Run ${cyan("draft publish")} again to retry.`));
      process.exit(3);
    }
  }

  console.log("");
  console.log(`${green("✓")} Published ${bold(String(published))} proposal(s) to team repo.`);
}

// ── load ───────────────────────────────────────────────────────────────────────

export async function runLoad(_args: string[]): Promise<void> {
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  // Check collaboration is configured before handing off to bash
  const collabResult = readCollaboration(workspace);
  if (!collabResult.ok) {
    console.error(red("No team repo configured."));
    console.error(dim("Run /draft:setup-collab in Claude Code first."));
    process.exit(2);
  }

  const code = await spawn(["bash", `${BACKGROUND}/load-team.sh`]);
  process.exit(code);
}
