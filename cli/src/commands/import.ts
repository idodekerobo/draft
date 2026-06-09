// commands/import — draft import <source>
// Non-AI import: heuristic dimension mapping from local path or GitHub repo.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, basename, dirname, extname } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { capture } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath } from "../utils/config.ts";
import { green, red, yellow, dim, cyan, bold } from "../utils/output.ts";

// Standard Draft dimensions + common aliases that map to them
const DIMENSION_MAP: Record<string, string> = {
  product: "product",
  products: "product",
  roadmap: "product",
  strategy: "product",
  vision: "product",
  company: "company",
  org: "company",
  business: "company",
  team: "team",
  people: "team",
  members: "team",
  priorities: "priorities",
  priority: "priorities",
  okrs: "priorities",
  goals: "priorities",
  sprint: "priorities",
  decisions: "decisions",
  decision: "decisions",
  adr: "decisions",
  research: "research",
  backlog: "backlog",
  ideas: "backlog",
};

function inferDimension(filePath: string, sourceRoot: string): string | null {
  // Use the immediate parent directory name as the primary signal
  const rel = filePath.replace(sourceRoot, "").replace(/^\//, "");
  const parts = rel.split("/");

  // Check each path component against the dimension map
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (DIMENSION_MAP[lower]) return DIMENSION_MAP[lower];
  }

  // Check the filename itself (without extension)
  const filename = basename(filePath, extname(filePath)).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (DIMENSION_MAP[filename]) return DIMENSION_MAP[filename];

  return null;
}

function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results.sort();
}

function buildProposal(
  sourceLabel: string,
  sourceRoot: string,
  files: string[],
  profile: string,
  dimensionMap: Map<string, string[]>,
  unmapped: string[],
): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 15) + "Z";

  const updates: string[] = [];

  for (const [dimension, paths] of dimensionMap) {
    const contents = paths.map((p) => {
      const rel = p.replace(sourceRoot, "").replace(/^\//, "");
      const body = readFileSync(p, "utf8").trim();
      return `### ${rel}\n\n${body}`;
    });

    updates.push(
      `  - file: context/${dimension}/index.md\n    action: append\n    content: |\n` +
      contents.map((c) => c.split("\n").map((l) => `      ${l}`).join("\n")).join("\n\n"),
    );
  }

  const frontmatter = [
    "---",
    `input_source: import`,
    `import_from: ${sourceLabel}`,
    `timestamp: ${ts}`,
    `profile: ${profile}`,
    `context_updates:`,
    ...updates,
    "---",
    "",
  ].join("\n");

  const summary = [
    `## Import preview`,
    ``,
    `**Source:** ${sourceLabel}`,
    `**Files processed:** ${files.length}`,
    ``,
  ];

  if (dimensionMap.size > 0) {
    summary.push("**Mapped:**");
    for (const [dim, paths] of dimensionMap) {
      const names = paths.map((p) => basename(p)).join(", ");
      summary.push(`- \`${dim}\` ← ${paths.length} file(s) (${names})`);
    }
    summary.push("");
  }

  if (unmapped.length > 0) {
    summary.push("**Unmapped (no dimension detected):**");
    for (const p of unmapped) {
      summary.push(`- ${basename(p)}`);
    }
    summary.push("");
    summary.push(
      `Run \`draft dimension add <name>\` or \`/draft:add-dimension <name>\` to create a custom dimension, then re-import.`,
    );
    summary.push("");
  }

  return frontmatter + summary.join("\n");
}

export async function runImport(args: string[]): Promise<void> {
  const preview = args.includes("--preview");
  const source = args.find((a) => !a.startsWith("--"));

  if (!source || args.includes("--help")) {
    printImportHelp();
    process.exit(source ? 0 : 1);
  }

  // ── Determine source type ───────────────────────────────────────────────────

  const isLocal = source.startsWith("/") || source.startsWith("~/") || source.startsWith("./");
  let sourceRoot: string;
  let tmpDir: string | null = null;

  if (isLocal) {
    sourceRoot = source.replace(/^~/, process.env.HOME ?? "~");
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      console.error(red(`Path not found or not a directory: ${source}`));
      process.exit(1);
    }
  } else {
    // GitHub repo — requires gh CLI
    const ghCheck = await capture(["gh", "auth", "status"]);
    if (ghCheck.exitCode !== 0) {
      console.error(red("GitHub CLI not authenticated."));
      console.error(`Run ${cyan("gh auth login --web")} then retry.`);
      process.exit(3);
    }

    const rand = Math.random().toString(36).slice(2, 8);
    tmpDir = join(tmpdir(), `draft-import-${rand}`);
    mkdirSync(tmpDir, { recursive: true });

    console.log(dim(`Cloning ${source}...`));
    const cloneResult = await capture([
      "gh", "repo", "clone", source, tmpDir, "--", "--depth", "1", "--quiet",
    ]);

    if (cloneResult.exitCode !== 0) {
      rmSync(tmpDir, { recursive: true, force: true });
      console.error(red(`Clone failed: ${cloneResult.stderr.trim() || "unknown error"}`));
      console.error("Check that the repo exists and you have access.");
      process.exit(1);
    }

    sourceRoot = tmpDir;
  }

  try {
    // ── Collect files ───────────────────────────────────────────────────────────

    const files = collectMdFiles(sourceRoot);

    if (files.length === 0) {
      console.error(yellow(`No markdown files found in ${source}.`));
      process.exit(0);
    }

    // ── Map to dimensions ───────────────────────────────────────────────────────

    const dimensionMap = new Map<string, string[]>();
    const unmapped: string[] = [];

    for (const file of files) {
      const dim = inferDimension(file, sourceRoot);
      if (dim) {
        if (!dimensionMap.has(dim)) dimensionMap.set(dim, []);
        dimensionMap.get(dim)!.push(file);
      } else {
        unmapped.push(file);
      }
    }

    // ── Preview or write proposal ───────────────────────────────────────────────

    const profile = getActiveProfile();
    const workspace = getWorkspacePath(profile);
    const proposalContent = buildProposal(source, sourceRoot, files, profile, dimensionMap, unmapped);

    if (preview) {
      console.log("");
      console.log(bold("Preview — no files will be written"));
      console.log("");
      console.log(dim(`Files found: ${files.length}`));
      if (dimensionMap.size > 0) {
        console.log(dim("Mapped:"));
        for (const [dim, paths] of dimensionMap) {
          console.log(`  ${green("→")} ${dim} (${paths.length} file(s))`);
        }
      }
      if (unmapped.length > 0) {
        console.log(dim(`Unmapped: ${unmapped.length} file(s)`));
      }
      console.log("");
      return;
    }

    const proposalsDir = join(workspace, "proposals");
    mkdirSync(proposalsDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 15) + "Z";
    const proposalPath = join(proposalsDir, `${ts}-import.md`);
    writeFileSync(proposalPath, proposalContent, "utf8");

    // ── Summary ─────────────────────────────────────────────────────────────────

    console.log("");
    console.log(`${green("✓")} Import staged as a proposal.`);
    console.log("");

    if (dimensionMap.size > 0) {
      console.log(dim("Mapped:"));
      for (const [dim, paths] of dimensionMap) {
        const names = paths.map((p) => basename(p)).join(", ");
        console.log(`  ${green("→")} ${bold(dim)} ← ${paths.length} file(s) (${names})`);
      }
    }

    if (unmapped.length > 0) {
      console.log("");
      console.log(dim(`Unmapped (${unmapped.length} file(s) — no dimension detected):`));
      for (const p of unmapped) {
        console.log(`  ${yellow("○")} ${basename(p)}`);
      }
    }

    console.log("");
    console.log(dim(`Run ${cyan("draft proposals")} to review and accept.`));
    console.log("");

  } finally {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ── help ───────────────────────────────────────────────────────────────────────

function printImportHelp(): void {
  console.log("Usage: draft import <source> [--preview]");
  console.log("");
  console.log("Arguments:");
  console.log(`  ${cyan("<source>")}    Local directory path or GitHub repo (owner/repo)`);
  console.log("");
  console.log("Options:");
  console.log(`  ${cyan("--preview")}   Show what would be imported without writing a proposal`);
  console.log("");
  console.log("Examples:");
  console.log(`  ${dim("draft import ~/notes")}`);
  console.log(`  ${dim("draft import owner/private-repo")}`);
  console.log(`  ${dim("draft import ~/notes --preview")}`);
  console.log("");
  console.log("For GitHub repos, requires gh CLI authenticated (gh auth login).");
  console.log("The import is staged as a proposal — run `draft proposals` to review.");
}
