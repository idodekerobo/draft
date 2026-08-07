// commands/dimension — draft dimension [list|add]

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getWorkspacePath } from "../utils/config";
import { green, red, yellow, dim, cyan, bold } from "../utils/output";

const DIMENSION_NAME_RE = /^[a-z0-9-]+$/;

const INDEX_TEMPLATE = (name: string) =>
  `---\nname: ${name}\ndescription: >\n  No information recorded yet.\nlast_updated: ""\nsource: ""\n---\n`;

export async function runDimension(args: string[]): Promise<void> {
  if (args.includes("--help") || args.length === 0) {
    printDimensionHelp();
    process.exit(0);
  }

  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "list":
      await listDimensions();
      break;
    case "add":
      await addDimension(rest);
      break;
    default:
      console.error(red(`Unknown subcommand: ${subcommand}`));
      console.error(`Subcommands: list, add`);
      process.exit(1);
  }
}

// ── list ───────────────────────────────────────────────────────────────────────

async function listDimensions(): Promise<void> {
  // TODO(cloud-context): replace this local inspection with the workspace context
  // API once the CLI becomes a supported M1 delivery surface.
  const workspacePath = getWorkspacePath();
  const contextPath = join(workspacePath, "context");

  if (!existsSync(contextPath)) {
    console.log(dim("No context directory found. Run `draft add claude-code` then `/draft:setup` to initialize."));
    return;
  }

  const entries = readdirSync(contextPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.log(dim("No dimensions found. Run `/draft:setup` to initialize your workspace."));
    return;
  }

  const initialized: string[] = [];
  const uninitialized: string[] = [];

  for (const name of entries) {
    const hasIndex = existsSync(join(contextPath, name, "index.md"));
    if (hasIndex) {
      initialized.push(name);
    } else {
      uninitialized.push(name);
    }
  }

  console.log("");

  if (initialized.length > 0) {
    console.log(dim("Initialized:"));
    for (const name of initialized) {
      console.log(`  ${green("✓")} ${name}`);
    }
  }

  if (uninitialized.length > 0) {
    if (initialized.length > 0) console.log("");
    console.log(dim("Uninitialized (missing index.md):"));
    for (const name of uninitialized) {
      console.log(`  ${yellow("○")} ${yellow(name)}`);
    }
    console.log("");
    console.log(dim(`Run ${cyan("draft dimension add <name>")} to scaffold any uninitialized dimension.`));
  }

  console.log("");
}

// ── add ────────────────────────────────────────────────────────────────────────

async function addDimension(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.error(red("Usage: draft dimension add <name>"));
    process.exit(1);
  }

  if (!DIMENSION_NAME_RE.test(name)) {
    console.error(red(`Invalid dimension name: '${name}'`));
    console.error("Dimension names may only contain lowercase letters, numbers, and hyphens.");
    process.exit(1);
  }

  const workspacePath = getWorkspacePath();
  const dimPath = join(workspacePath, "context", name);
  const indexPath = join(dimPath, "index.md");
  const logPath = join(dimPath, "log");

  if (existsSync(indexPath)) {
    console.log(yellow(`Dimension '${name}' is already initialized.`));
    console.log(dim("Run `/draft:setup` re-run from your agent session to update its content."));
    process.exit(0);
  }

  const scaffoldOnly = existsSync(dimPath);
  if (scaffoldOnly) {
    console.log(dim(`Folder '${name}/' already exists — adding missing index.md and log/.`));
  }

  mkdirSync(dimPath, { recursive: true });
  mkdirSync(logPath, { recursive: true });
  writeFileSync(indexPath, INDEX_TEMPLATE(name), "utf8");

  console.log(`${green("✓")} Dimension ${bold(name)} scaffolded.`);
  console.log(dim(`  context/${name}/index.md  created`));
  console.log(dim(`  context/${name}/log/      created`));
  console.log("");
  console.log(dim(`Draft will load ${cyan(name)} every session. Open your agent and run`));
  console.log(dim(`${cyan("/draft:add-dimension " + name)} to seed initial context.`));
}

// ── help ───────────────────────────────────────────────────────────────────────

function printDimensionHelp(): void {
  console.log("Usage: draft dimension <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log(`  ${cyan("list")}           List all dimensions and their status`);
  console.log(`  ${cyan("add <name>")}     Scaffold a new dimension (index.md + log/)`);
}
