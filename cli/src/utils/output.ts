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
    ["integrations list",          "List hosted integration status"],
    ["integrations connect <provider>", "Connect github, linear, claude-code, slack, or fireflies"],
    ["integrations disconnect <provider>", "Disconnect GitHub, Fireflies, Linear, or Slack"],
    ["sessions enable claude-code", "Capture this repo's Claude Code sessions (see sessions enable --help)"],
    ["sessions rotate",            "Rotate this repo's session-ingest credential"],
    ["sessions disable",           "Stop capturing this repo's sessions"],
    ["sessions status",            "Show this repo's session-capture state"],
    ["sessions list",              "List captured coding sessions"],
    ["sessions read <id>",         "Print a session's summary or transcript"],
    ["sessions search \"<pattern>\"", "Search session summaries by keyword"],
    ["update",                     "Update the draft CLI to the latest release"],
    ["update --check",             "Check for an update without installing it"],
    ["completion",                 "Generate shell tab completion script"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${cyan(cmd.padEnd(36))}${desc}`);
  }
  console.log("");
  console.log(`Getting started: run ${cyan("draft auth login")} to sign in,`);
  console.log(`then ${cyan("draft context list")} to see what's available.`);
  console.log("");
  console.log(`Run ${cyan("draft <command> --json")} for machine-readable output.`);
  console.log(`Run ${cyan("draft --version")} to print the installed CLI version.`);
  console.log(`Exit codes: 0=success  1=auth/API error  2=invalid usage  130=interrupted`);
}
