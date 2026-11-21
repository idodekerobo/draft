// commands/activity.ts — draft activity list: what the workspace's agents have run, newest first.
// The command is the MCP tool activity.list; --json prints that tool's answer.

import { callPersonTool, runModeErrorMessage } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

interface ActivityRun {
  id: string;
  kind: "interactive" | "routine" | "synthesis" | "summarization";
  sessionId: string | null;
  routineId: string | null;
  routineTitle: string | null;
  status: string;
  resultSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<ActivityRun["kind"], string> = {
  routine: "Routine",
  synthesis: "Context update",
  summarization: "Session summaries",
  interactive: "Interactive session",
};

const HELP = `${bold("draft activity")} — what the workspace's agents have run.

usage: draft activity list [--cursor <c>] [--json]

Lists runs newest first, 50 at a time: routine runs, context updates, session
summaries and interactive sessions, with status, timing and result.

  --cursor <c>   Show older runs: pass the cursor printed after the last page.
  --json         Print the answer as JSON, including nextCursor.

For one routine's runs and their transcripts, use \`draft routines runs <id>\`.

Examples:
  draft activity list
  draft activity list --cursor '<cursor from the last page>'`;

function duration(run: ActivityRun): string {
  if (!run.startedAt || !run.completedAt) return "";
  const seconds = (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
  return seconds >= 0 ? ` (${seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`})` : "";
}

function formatRun(run: ActivityRun): string {
  const what = run.kind === "routine" ? `${run.routineTitle ?? "Routine"} · routine` : KIND_LABEL[run.kind] ?? run.kind;
  const lines = [`${run.createdAt}  ${run.status.padEnd(10)}  ${what}${duration(run)}`];
  if (run.resultSummary) lines.push(`  ${run.resultSummary}`);
  if (run.kind === "routine" && run.routineId && run.sessionId) lines.push(dim(`  draft routines runs ${run.routineId} --session-id ${run.sessionId}`));
  return lines.join("\n");
}

async function runList(args: string[]): Promise<number> {
  const command = "draft activity list";
  const json = args.includes("--json");
  let cursor: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") continue;
    if (arg === "--cursor" || arg.startsWith("--cursor=")) {
      cursor = arg.includes("=") ? arg.slice("--cursor=".length) : args[++index];
      if (!cursor) return fail(command, json, "invalid_usage", "--cursor requires a value", EXIT_USAGE_ERROR);
      continue;
    }
    return fail(command, json, "invalid_usage", `unexpected argument: ${arg}`, EXIT_USAGE_ERROR);
  }

  const result = await callPersonTool("activity.list", cursor ? { cursor } : {});
  if (!result.ok) {
    const code = result.toolStatus ? (result.refusal ?? result.code) : result.code;
    const message = result.toolStatus ? (result.message ?? "Could not read activity.") : runModeErrorMessage(code) ?? (code === "not_authenticated" ? "Not signed in. Run `draft auth login`." : "Could not reach Draft. Retry shortly.");
    return fail(command, json, code, message, EXIT_OPERATIONAL_ERROR);
  }
  const output = result.output as { runs?: ActivityRun[]; nextCursor?: string | null };
  if (json) {
    printJsonLine(output as Record<string, unknown>);
    return EXIT_SUCCESS;
  }
  const runs = output.runs ?? [];
  console.log(runs.length ? runs.map(formatRun).join("\n") : "No activity yet.");
  if (output.nextCursor) console.log(dim(`Older runs: draft activity list --cursor '${output.nextCursor}'`));
  return EXIT_SUCCESS;
}

function fail(command: string, json: boolean, code: string, message: string, exitCode: number): number {
  if (json) printJsonLine(errorPayload(code, message));
  else console.error(red(`${command}: ${message}`));
  return exitCode;
}

export async function runActivity(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  if (sub !== "list") {
    console.error(red(`draft activity: unknown subcommand "${sub}". Use list.`));
    return EXIT_USAGE_ERROR;
  }
  return runList(rest);
}
