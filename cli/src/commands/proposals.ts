// commands/proposals.ts — interactive approve/reject pending AI proposals
//
// Reads proposals once at startup (no file-watching).
// Keypress: [a]ccept  [r]eject  [s]kip  [q]uit

import { existsSync, readdirSync, renameSync, statSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { capture } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath } from "../utils/config.ts";
import { green, red, yellow, dim, cyan, bold } from "../utils/output.ts";

const BACKGROUND = `${process.env.HOME}/.draft/background`;

interface Proposal {
  filename: string;
  path: string;
  mtime: number;
  source: string;
  createdAt: string;
  summary: string;
  body: string;
}

export async function runProposals(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft proposals");
    console.log("Interactively review pending AI-generated context proposals.");
    console.log("Keys: [a]ccept  [r]eject  [s]kip  [q]uit");
    process.exit(0);
  }

  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);
  const proposalsDir = join(workspace, "proposals");
  const acceptedDir = join(workspace, "accepted");
  const rejectedDir = join(workspace, "rejected");

  if (!existsSync(proposalsDir)) {
    console.log(dim("No pending proposals."));
    process.exit(0);
  }

  // Scan once at startup (oldest first)
  const files = readdirSync(proposalsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, path: join(proposalsDir, f), mtime: statSync(join(proposalsDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  if (files.length === 0) {
    console.log(dim("No pending proposals."));
    process.exit(0);
  }

  const proposals: Proposal[] = files.map((f) => parseProposal(f.name, f.path));

  console.log("");
  console.log(`${bold(String(proposals.length))} pending proposal(s). Keys: ${cyan("[a]ccept")}  ${red("[r]eject")}  ${dim("[s]kip")}  ${dim("[q]uit")}`);
  console.log("");

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    printProposalHeader(proposal, i + 1, proposals.length);

    const key = await readKey();

    if (key === "q") {
      console.log(dim("\nQuit."));
      process.exit(0);
    }

    if (key === "a") {
      ensureDir(acceptedDir);
      const dest = join(acceptedDir, proposal.filename);
      renameSync(proposal.path, dest);

      // Attempt immediate commit
      const ghResult = await capture(["gh", "api", "user", "--jq", ".login"]);
      const ghUsername = ghResult.exitCode === 0 ? ghResult.stdout.trim() : "";

      if (ghUsername) {
        const commitScript = join(BACKGROUND, "commit-to-team-context.sh");
        const result = await capture(
          ["bash", commitScript, dest, getWorkspacePath(), ghUsername],
          { timeoutMs: 60_000 }
        );
        if (result.exitCode === 0) {
          console.log(`\n${green("[✓]")} Accepted and pushed.`);
        } else {
          console.log(`\n${green("[✓]")} Accepted locally. ${yellow("⚠")}  Push failed — run ${cyan("draft publish")} when ready.`);
        }
      } else {
        console.log(`\n${green("[✓]")} Accepted locally. ${dim("(gh not authenticated — run `draft publish` to push)")}`);
      }
    } else if (key === "r") {
      ensureDir(rejectedDir);
      renameSync(proposal.path, join(rejectedDir, proposal.filename));
      console.log(`\n${red("[✗]")} Rejected.`);
    } else {
      // skip
      console.log(`\n${dim("[~]")} Skipped.`);
    }
    console.log("");
  }

  console.log(dim("All proposals reviewed."));
}

// ── Proposal parsing ───────────────────────────────────────────────────────────

function parseProposal(filename: string, filePath: string): Proposal {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    // ignore
  }

  // Extract YAML frontmatter between first two ---
  let source = "unknown";
  let createdAt = "";
  let summary = filename;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const sourceMatch = fm.match(/^source:\s*(.+)$/m);
    const dateMatch = fm.match(/^created_at:\s*(.+)$/m);
    const summaryMatch = fm.match(/^summary:\s*(.+)$/m);
    if (sourceMatch) source = sourceMatch[1].trim();
    if (dateMatch) createdAt = dateMatch[1].trim();
    if (summaryMatch) summary = summaryMatch[1].trim();
  }

  // Body is everything after the frontmatter
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

  return {
    filename,
    path: filePath,
    mtime: statSync(filePath).mtimeMs,
    source,
    createdAt,
    summary,
    body,
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function printProposalHeader(p: Proposal, index: number, total: number): void {
  const separator = "─".repeat(50);
  console.log(dim(separator));
  console.log(`${dim(`[${index}/${total}]`)}  ${bold("source:")} ${cyan(p.source)}${p.createdAt ? `  ${dim(p.createdAt)}` : ""}`);
  console.log(`${bold("summary:")} ${p.summary}`);
  if (p.body) {
    console.log("");
    // Print first 20 lines of body as diff preview
    const lines = p.body.split("\n").slice(0, 20);
    for (const line of lines) {
      if (line.startsWith("+")) {
        console.log(green(line));
      } else if (line.startsWith("-")) {
        console.log(red(line));
      } else {
        console.log(dim(line));
      }
    }
    if (p.body.split("\n").length > 20) {
      console.log(dim("  ... (truncated)"));
    }
  }
  console.log("");
  process.stdout.write(`${cyan("[a]ccept")}  ${red("[r]eject")}  ${dim("[s]kip")}  ${dim("[q]uit")}  › `);
}

// ── Single keypress reader ─────────────────────────────────────────────────────

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const handler = (key: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", handler);

      const k = key.toLowerCase();
      if (k === "a" || k === "r" || k === "s" || k === "q" || k === "\u0003" /* Ctrl+C */) {
        resolve(k === "\u0003" ? "q" : k);
      } else {
        // invalid key — re-prompt
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once("data", handler);
      }
    };

    process.stdin.once("data", handler);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
