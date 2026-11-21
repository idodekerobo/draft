// utils/output.ts — ANSI color helpers and status rendering

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

export const bold = (s: string) => `${BOLD}${s}${RESET}`;
export const dim = (s: string) => `${DIM}${s}${RESET}`;
export const red = (s: string) => `${RED}${s}${RESET}`;
export const green = (s: string) => `${GREEN}${s}${RESET}`;
export const yellow = (s: string) => `${YELLOW}${s}${RESET}`;
export const cyan = (s: string) => `${CYAN}${s}${RESET}`;

export function printHelp(): void {
  console.log(`${bold("Draft")} — hosted control plane client for Claude Code, Codex, and Cursor`);
  console.log("");
  console.log(`Usage: ${cyan("draft")} <command> [args]`);
  console.log("");
  console.log("Commands:");
  const cmds: [string, string][] = [
    ["add <tool> [--dir <path>...]", "Configure a project's instruction file for an agent tool"],
    ["auth login",                 "Sign in via device pairing"],
    ["auth logout",                "Sign out and clear local credentials"],
    ["auth whoami",                "Show the current signed-in identity"],
    ["context list",               "List available context dimensions"],
    ["context read --dimension <name>", "Print one or more context dimensions"],
    ["context read --all",         "Print every context dimension"],
    ["context read --dimension memory --period <today|this-week|...>", "Print one memory period (day/week/month)"],
    ["context export [--out <dir>|--zip <file>]", "Export the full context as markdown files (--force to overwrite)"],
    ["people find [name] [--me]",  "Find the people in the workspace"],
    ["people create <name>",       "Add a teammate (an admin approves them)"],
    ["people pending",             "List people waiting for approval"],
    ["people approve <id|name>",   "Approve a pending person (admins)"],
    ["people reject <id|name>",    "Reject a pending person (admins)"],
    ["people notify <id|name> <message>", "Send a message to a person"],
    ["routines list|options|create|update|delete|run|runs", "Routines: work Draft runs once, on a schedule, or when something happens"],
    ["activity list",              "What the workspace's agents have run, newest first"],
    ["sources list",              "Browse ingested source evidence"],
    ["sources search \"<query>\"", "Search cross-provider source evidence"],
    ["sources capture enable claude-code", "Capture this repo's Claude Code sessions"],
    ["sources read <source_item_id>", "Read a source or an available original representation"],
    ["sessions list",              "List Draft app conversations"],
    ["sessions read <id>",         "Read a Draft app session and its events"],
    ["connections list",          "Show each connection's status and what you can do with it"],
    ["connections connect --provider <provider>", "Connect github, slack, linear, fireflies, granola, or claude-code"],
    ["connections disconnect --provider <provider>", "Disconnect GitHub, Slack, Linear, Fireflies, or Granola"],
    ["connections read --provider <provider> --channel <channel>", "Read recent messages from a provider (slack)"],
    ["connections post --provider <provider> --channel <channel> --text <text>", "Post a message through a provider (slack)"],
    ["skills list",                "List the company's skill marketplace"],
    ["skills read <name>",         "Print one skill's full description and content"],
    ["skills add [<name>] --description \"<text>\"", "Save a new company skill (see skills --help)"],
    ["skills update <name>",       "Replace a skill's content/description"],
    ["skills remove <name>",       "Soft-delete a skill"],
    ["update",                     "Update the draft CLI to the latest release"],
    ["update --check",             "Check for an update without installing it"],
    ["uninstall",                  "Remove the draft CLI (keeps ~/.draft data)"],
    ["completion",                 "Generate shell tab completion script"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${cyan(cmd.padEnd(36))}${desc}`);
  }
  console.log("");
  console.log(`Getting started: run ${cyan("draft auth login")} to sign in,`);
  console.log(`then ${cyan("draft context list")} for the maintained map, or ${cyan("draft sources search \"<query>\"")} for evidence.`);
  console.log("");
  console.log(`Run ${cyan("draft <command> --json")} for machine-readable output.`);
  console.log(`Run ${cyan("draft --version")} to print the installed CLI version.`);
  console.log(`Exit codes: 0=success  1=auth/API error  2=invalid usage  130=interrupted`);
}
