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

export type DotState = "running" | "stopped" | "degraded" | "unknown";

export function dot(state: DotState): string {
  switch (state) {
    case "running":  return green("●");
    case "stopped":  return red("◯");
    case "degraded": return yellow("⚠");
    case "unknown":  return dim("◯");
  }
}

export function printHelp(): void {
  console.log(`${bold("Draft")} — PM brain for Claude Code, Codex, and Cursor`);
  console.log("");
  console.log(`Usage: ${cyan("draft")} <command> [args]`);
  console.log("");
  console.log("Commands:");
  const cmds: [string, string][] = [
    ["status",              "Show daemon status and integration health"],
    ["start",               "Start the background daemon"],
    ["stop",                "Stop the background daemon"],
    ["add <tool>",          "Add Draft to a CLI tool (claude-code, codex, cursor)"],
    ["switch <name>",       "Activate a named profile"],
    ["profiles",            "Manage profiles (list, create, rename, delete)"],
    ["publish",             "Push context to shared team repo"],
    ["load",                "Pull team context from shared repo"],
    ["logs",                "Tail daemon logs (--follow, --errors)"],
    ["proposals",           "Review and approve/reject AI-generated context updates"],
    ["doctor",              "Diagnose configuration and dependency issues"],
    ["completion",          "Generate shell tab completion script"],
    ["update",              "Pull latest from repo and reinstall plugin files"],
    ["uninstall",           "Remove all of Draft and configuration (not just one tool)"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${cyan(cmd.padEnd(26))}${desc}`);
  }
  console.log("");
  console.log(`Getting started: run ${cyan("draft add claude-code")} to add Draft to Claude Code,`);
  console.log(`then open Claude Code and run ${cyan("/draft:setup")} to initialize your workspace.`);
  console.log("");
  console.log(`Run ${cyan("draft <command> --help")} for details.`);
  console.log(`Exit codes: 0=success  1=user error  2=config error  3=dep/daemon failure`);
}
