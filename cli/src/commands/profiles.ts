// commands/profiles.ts — draft profiles [list|create|rename|delete]

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getActiveProfile } from "../utils/config.ts";
import { green, red, yellow, dim, cyan, bold } from "../utils/output.ts";

const HOME = process.env.HOME!;
const DRAFT_GLOBAL = `${HOME}/.draft`;
const WORKSPACES_DIR = `${DRAFT_GLOBAL}/workspaces`;

const WORKSPACE_DIRS = [
  "context",
  "config",
  "proposals",
  "accepted",
  "rejected",
  "docs",
];

export async function runProfiles(args: string[]): Promise<void> {
  if (args.includes("--help") || args.length === 0) {
    printProfilesHelp();
    process.exit(args.length === 0 ? 0 : 0);
  }

  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "list":
      await listProfiles();
      break;
    case "create":
      await createProfile(rest);
      break;
    case "rename":
      await renameProfile(rest);
      break;
    case "delete":
      await deleteProfile(rest);
      break;
    default:
      // Treat unknown arg as a profile name attempt, suggest correction
      console.error(red(`Unknown subcommand: ${subcommand}`));
      console.error(`Subcommands: list, create, rename, delete`);
      process.exit(1);
  }
}

// ── list ───────────────────────────────────────────────────────────────────────

async function listProfiles(): Promise<void> {
  const active = getActiveProfile();

  if (!existsSync(WORKSPACES_DIR)) {
    console.log(dim("No profiles found. Run `draft add claude-code` to get started."));
    return;
  }

  const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.log(dim("No profiles found."));
    return;
  }

  console.log("");
  for (const name of entries) {
    const marker = name === active ? green("* ") : "  ";
    console.log(`${marker}${name === active ? bold(name) : name}`);
  }
  console.log("");
  console.log(dim(`Active profile: ${active}. Use \`draft switch <name>\` to change.`));
}

// ── create ─────────────────────────────────────────────────────────────────────

async function createProfile(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error(red("Usage: draft profiles create <name>"));
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error(red(`Invalid profile name: '${name}'`));
    console.error("Profile names may only contain letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }

  const workspacePath = join(WORKSPACES_DIR, name);
  if (existsSync(workspacePath)) {
    console.error(yellow(`Profile '${name}' already exists.`));
    console.error(`Run ${cyan("draft switch " + name)} to activate it.`);
    process.exit(1);
  }

  // Create directory structure
  for (const dir of WORKSPACE_DIRS) {
    mkdirSync(join(workspacePath, dir), { recursive: true });
  }

  console.log(`${green("✓")} Profile ${bold(name)} created.`);
  console.log(dim(`Run \`draft switch ${name}\` to activate it.`));
}

// ── rename ─────────────────────────────────────────────────────────────────────

async function renameProfile(args: string[]): Promise<void> {
  const [oldName, newName] = args;
  if (!oldName || !newName) {
    console.error(red("Usage: draft profiles rename <old-name> <new-name>"));
    process.exit(1);
  }

  const oldPath = join(WORKSPACES_DIR, oldName);
  const newPath = join(WORKSPACES_DIR, newName);

  if (!existsSync(oldPath)) {
    console.error(red(`Profile '${oldName}' not found.`));
    process.exit(1);
  }

  if (existsSync(newPath)) {
    console.error(red(`Profile '${newName}' already exists.`));
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
    console.error(red(`Invalid profile name: '${newName}'`));
    process.exit(1);
  }

  renameSync(oldPath, newPath);

  // Update active-profile if it was the renamed one
  const active = getActiveProfile();
  if (active === oldName) {
    writeFileSync(`${DRAFT_GLOBAL}/active-profile`, newName, "utf8");
    console.log(`${green("✓")} Renamed '${oldName}' → '${newName}' and updated active profile.`);
  } else {
    console.log(`${green("✓")} Renamed '${oldName}' → '${newName}'.`);
  }
}

// ── delete ─────────────────────────────────────────────────────────────────────

async function deleteProfile(args: string[]): Promise<void> {
  const hasForce = args.includes("--force");
  const name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    console.error(red("Usage: draft profiles delete <name> [--force]"));
    process.exit(1);
  }

  const workspacePath = join(WORKSPACES_DIR, name);
  if (!existsSync(workspacePath)) {
    console.error(red(`Profile '${name}' not found.`));
    process.exit(1);
  }

  const active = getActiveProfile();
  if (active === name && !hasForce) {
    console.error(yellow(`'${name}' is the active profile.`));
    console.error(`Use ${cyan("--force")} to delete the active profile, or switch first with ${cyan("draft switch <other>")}.`);
    process.exit(1);
  }

  rmSync(workspacePath, { recursive: true, force: true });
  console.log(`${green("✓")} Profile '${name}' deleted.`);
}

// ── help ───────────────────────────────────────────────────────────────────────

function printProfilesHelp(): void {
  console.log("Usage: draft profiles <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log(`  ${cyan("list")}                    List all profiles (active profile marked with *)`);
  console.log(`  ${cyan("create <name>")}          Create a new blank profile`);
  console.log(`  ${cyan("rename <old> <new>")}     Rename a profile`);
  console.log(`  ${cyan("delete <name>")}          Delete a profile (--force to delete active)`);
}
