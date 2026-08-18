// commands/add.ts — draft add <tool> [--dir <path>...] [--json]
//
// Project-local agent setup. Configures a selected repository's instruction
// file so the target coding agent discovers Draft and the CLI commands it
// may call (auth login, context list, context read). Does not install the
// Draft CLI binary, does not bootstrap a daemon, and never mutates global
// tool configuration.

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, cyan, dim, green, red } from "../utils/output.ts";

const SUPPORTED_TOOLS = ["claude-code", "codex", "cursor", "openclaw", "hermes"] as const;
type Tool = (typeof SUPPORTED_TOOLS)[number];

const INSTRUCTION_FILE: Record<Tool, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  cursor: "AGENTS.md",
  openclaw: "AGENTS.md",
  hermes: "HERMES.md",
};

const MANAGED_BLOCK_BEGIN = "<!-- draft:begin (managed by Draft — do not edit this block) -->";
const MANAGED_BLOCK_END = "<!-- draft:end -->";

const MANAGED_BLOCK_BODY = [
  "## Draft context",
  "",
  "This project uses Draft for its company brain and agent context.",
  "",
  "Use the CLI below to access the company brain — Draft's current, synthesized",
  "context about the product, team, and priorities — whenever you need it.",
  "",
  "- `draft auth login` — sign in if a command reports you're not authenticated.",
  "- `draft context list` — discover available context dimensions.",
  "- `draft context read --dimension <name>` (repeatable) or `--all` — read current context.",
  "- `draft --help` — see all available commands.",
].join("\n");

interface ParsedArgs {
  tool?: Tool;
  dirs: string[];
  json: boolean;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const dirs: string[] = [];
  let json = false;
  let tool: Tool | undefined;
  let toolSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--dir") {
      const value = args[++i];
      if (value === undefined) return { dirs, json, error: "--dir requires a value" };
      dirs.push(value);
      continue;
    }
    if (arg.startsWith("--dir=")) { dirs.push(arg.slice("--dir=".length)); continue; }
    if (arg.startsWith("--")) return { dirs, json, error: `unknown flag: ${arg}` };
    if (toolSeen) return { dirs, json, error: `unexpected argument: ${arg}` };
    toolSeen = true;
    if (!(SUPPORTED_TOOLS as readonly string[]).includes(arg)) {
      return { dirs, json, error: `unknown tool: ${arg} (expected one of ${SUPPORTED_TOOLS.join(", ")})` };
    }
    tool = arg as Tool;
  }

  if (!tool) return { dirs, json, error: `missing tool — expected one of ${SUPPORTED_TOOLS.join(", ")}` };
  return { tool, dirs, json };
}

async function promptForDirs(): Promise<string[]> {
  const cwd = process.cwd();
  process.stdout.write(`Project directory ${dim(`[${cwd}]`)}: `);
  const first = (await readLine()).trim();
  return [first || cwd];
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

interface DirResult {
  dir: string;
  ok: true;
  filePath: string;
  wrote: boolean;
}

interface DirError {
  dir: string;
  ok: false;
  code: string;
  message: string;
}

function validateAndWrite(rawDir: string, tool: Tool): DirResult | DirError {
  const dir = isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir);

  if (!existsSync(dir)) {
    return { dir: rawDir, ok: false, code: "directory_not_found", message: `directory not found: ${dir}` };
  }
  if (!statSync(dir).isDirectory()) {
    return { dir: rawDir, ok: false, code: "not_a_directory", message: `not a directory: ${dir}` };
  }

  const fileName = INSTRUCTION_FILE[tool];
  const filePath = resolve(dir, fileName);

  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      return { dir: rawDir, ok: false, code: "symlink_target", message: `refusing to write through a symlink: ${filePath}` };
    }
  } catch {
    // file doesn't exist yet — fine
  }

  const wrote = writeManagedBlock(filePath);
  return { dir: rawDir, ok: true, filePath, wrote };
}

/**
 * Returns true if the file's bytes changed, false if the managed block was
 * already current (no write performed) — needed for idempotent no-op reruns.
 */
function writeManagedBlock(filePath: string): boolean {
  const block = `${MANAGED_BLOCK_BEGIN}\n${MANAGED_BLOCK_BODY}\n${MANAGED_BLOCK_END}`;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";

  const beginIdx = existing.indexOf(MANAGED_BLOCK_BEGIN);
  let next: string;
  if (beginIdx !== -1) {
    const endIdx = existing.indexOf(MANAGED_BLOCK_END, beginIdx);
    if (endIdx !== -1) {
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(endIdx + MANAGED_BLOCK_END.length).replace(/^\n/, "");
      next = before + block + (after ? "\n" + after : "\n");
    } else {
      next = existing.slice(0, beginIdx) + block + "\n";
    }
  } else {
    const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    next = existing + sep + block + "\n";
  }

  if (next === existing) return false;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, next);
  return true;
}

export async function runAdd(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else {
      console.error(red(`draft add: ${parsed.error}`));
      console.error(`Usage: draft add <${SUPPORTED_TOOLS.join("|")}> [--dir <path>...] [--json]`);
    }
    return EXIT_USAGE_ERROR;
  }
  const { tool, json } = parsed;
  let dirs = parsed.dirs;

  if (dirs.length === 0) {
    if (!process.stdin.isTTY) {
      const message = "no --dir given and stdin is not a TTY — pass one or more --dir <path>";
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft add: ${message}`));
      return EXIT_USAGE_ERROR;
    }
    dirs = await promptForDirs();
  }

  const results = dirs.map((d) => validateAndWrite(d, tool!));
  const failures = results.filter((r): r is DirError => !r.ok);
  const successes = results.filter((r): r is DirResult => r.ok);

  if (json) {
    printJsonLine({
      status: failures.length === 0 ? "ok" : "partial_error",
      tool,
      results: results.map((r) =>
        r.ok
          ? { dir: r.dir, ok: true, file: r.filePath, changed: r.wrote }
          : { dir: r.dir, ok: false, code: r.code, message: r.message }
      ),
    });
  } else {
    for (const r of successes) {
      console.log(`  ${green("✓")} ${r.filePath} ${dim(r.wrote ? "(updated)" : "(already current)")}`);
    }
    for (const r of failures) {
      console.error(`  ${red("✗")} ${r.dir}: ${r.message}`);
    }
    if (successes.length > 0) {
      console.log("");
      console.log(`${bold(`Draft configured for ${tool}`)}.`);
      console.log(`Run ${cyan("draft auth login")} to sign in, then ${cyan("draft context list")} to see available context.`);
    }
  }

  return failures.length === 0 ? EXIT_SUCCESS : EXIT_OPERATIONAL_ERROR;
}
