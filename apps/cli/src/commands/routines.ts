// commands/routines.ts — draft routines list | show | create | update | delete | run | runs
//
// Scheduled background tasks in the workspace. `list` and `show` read the routine list. The other
// commands are Draft tools, called as the signed-in person.

import { readFile } from "node:fs/promises";
import { callPersonTool, fetchRoutines, type FetchErrorCode, type RoutineSummary } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine, type ErrorPayload } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

const HARNESSES = ["claude", "codex"];
const PRESETS = ["draft_default", "hourly", "daily", "weekdays", "weekly"];

const VALUE_FLAGS = new Set(["title", "prompt", "prompt-file", "harness", "model", "preset", "time", "weekday", "timezone", "post-channels", "on"]);
const BOOLEAN_FLAGS = new Set(["json", "notify", "no-notify", "no-post"]);
const SCHEDULE_FIELDS = ["preset", "time", "weekday", "timezone"];
const PATCH_FIELDS = ["title", "harness", "model", "preset", "time", "weekday", "timezone"];

const CREATE_USAGE = "usage: draft routines create --title <title> (--prompt <text> | --prompt-file <path>) --harness <claude|codex> --preset <preset> [--model <id>] [--time HH:MM] [--weekday <sun..sat>] [--timezone <zone>] [--notify] [--post-channels joined|#a,#b] [--on <event>] [--json]";
const UPDATE_USAGE = "usage: draft routines update <id> [--title <t>] [--prompt <text> | --prompt-file <path>] [--harness <h>] [--model <id>] [--preset <p>] [--time HH:MM] [--weekday <d>] [--timezone <zone>] [--notify | --no-notify] [--post-channels joined|#a,#b | --no-post] [--on <event>] [--json]";

interface Flags {
  positionals: string[];
  values: Record<string, string>;
  events: string[];
  switches: Set<string>;
  error?: string;
}

type ToolOutcome = { output: unknown } | number;

function parseFlags(args: string[]): Flags {
  const flags: Flags = { positionals: [], values: {}, events: [], switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      flags.positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      flags.switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return { ...flags, error: `unknown flag: ${arg}` };
    const value = inline ?? args[++i];
    if (value === undefined) return { ...flags, error: `--${name} requires a value` };
    if (name === "on") flags.events.push(...splitList(value));
    else flags.values[name] = value;
  }
  return flags;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function transportError(code: FetchErrorCode): ErrorPayload {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  return errorPayload(code, "Could not reach routines right now. Retry shortly.");
}

function fail(command: string, json: boolean, payload: ErrorPayload, exitCode = EXIT_OPERATIONAL_ERROR): number {
  if (json) printJsonLine(payload);
  else console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
  return exitCode;
}

function usage(command: string, json: boolean, message: string): number {
  return fail(command, json, errorPayload("invalid_usage", message), EXIT_USAGE_ERROR);
}

async function callTool(command: string, json: boolean, tool: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await callPersonTool(tool, input);
  if (result.ok) return { output: result.output };
  if (result.toolStatus) return fail(command, json, errorPayload(result.refusal ?? result.code, result.message ?? "The routine request did not work."));
  return fail(command, json, transportError(result.code));
}

function choiceError(name: string, value: string | undefined, choices: string[]): string | undefined {
  if (value === undefined || choices.includes(value)) return undefined;
  return `--${name} must be one of: ${choices.join(", ")}`;
}

function scheduleFields(values: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of SCHEDULE_FIELDS) if (values[key] !== undefined) fields[key] = values[key]!;
  return fields;
}

function postChannelsValue(raw: string): "joined" | string[] {
  return raw === "joined" ? "joined" : splitList(raw);
}

// Returns the prompt text from --prompt or --prompt-file. Both flags together is an error.
async function loadPrompt(flags: Flags): Promise<{ text?: string; error?: string }> {
  const prompt = flags.values.prompt;
  const file = flags.values["prompt-file"];
  if (prompt !== undefined && file !== undefined) return { error: "give --prompt or --prompt-file, not both" };
  if (prompt !== undefined) return { text: prompt };
  if (file === undefined) return {};
  try {
    return { text: await readFile(file, "utf8") };
  } catch {
    return { error: `cannot read --prompt-file: ${file}` };
  }
}

function formatRoutine(routine: RoutineSummary): string {
  return [
    `${bold(routine.title)} — ${routine.enabled ? "enabled" : "disabled"}`,
    `  schedule: ${routine.scheduleDescription}`,
    ...(routine.cron ? [`  cron: ${routine.cron} (${routine.timezone})`] : []),
    `  next run: ${routine.nextRunAt ?? "none scheduled"}`,
  ].join("\n");
}

async function runList(args: string[]): Promise<number> {
  const command = "draft routines list";
  const json = args.includes("--json");
  const unexpected = args.find((arg) => arg !== "--json");
  if (unexpected) return usage(command, json, `unexpected argument: ${unexpected}`);

  const result = await fetchRoutines();
  if (!result.ok) return fail(command, json, transportError(result.code));
  if (json) {
    printJsonLine({ routines: result.value });
    return EXIT_SUCCESS;
  }
  if (result.value.length === 0) {
    console.log("No routines found.");
    return EXIT_SUCCESS;
  }
  console.log(result.value.map(formatRoutine).join("\n\n"));
  return EXIT_SUCCESS;
}

async function runShow(args: string[]): Promise<number> {
  const command = "draft routines show";
  const flags = parseFlags(args);
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, "usage: draft routines show <id> [--json]");

  const result = await fetchRoutines();
  if (!result.ok) return fail(command, json, transportError(result.code));
  const routine = result.value.find((item) => item.id === id);
  if (!routine) return fail(command, json, errorPayload("routine_not_found", `Routine not found: ${id}`));
  if (json) printJsonLine({ routine });
  else console.log(formatRoutine(routine));
  return EXIT_SUCCESS;
}

async function runCreate(args: string[]): Promise<number> {
  const command = "draft routines create";
  const flags = parseFlags(args);
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  if (flags.positionals.length) return usage(command, json, `unexpected argument: ${flags.positionals[0]}`);
  if (flags.switches.has("no-notify") || flags.switches.has("no-post")) return usage(command, json, "--no-notify and --no-post only apply to update");

  const prompt = await loadPrompt(flags);
  if (prompt.error) return usage(command, json, prompt.error);
  const { title, harness, preset } = flags.values;
  if (!title || !harness || !preset || !prompt.text) return usage(command, json, CREATE_USAGE);
  const badChoice = choiceError("harness", harness, HARNESSES) ?? choiceError("preset", preset, PRESETS);
  if (badChoice) return usage(command, json, badChoice);

  const postChannels = flags.values["post-channels"];
  const body = {
    title,
    prompt: prompt.text,
    harness,
    model: flags.values.model ?? null,
    schedule: scheduleFields(flags.values),
    ...(flags.switches.has("notify") ? { canNotify: true } : {}),
    ...(postChannels !== undefined ? { postChannels: postChannelsValue(postChannels) } : {}),
    ...(flags.events.length ? { events: flags.events } : {}),
  };
  const result = await callTool(command, json, "routines.create", body);
  if (typeof result === "number") return result;
  if (json) printJsonLine(asRecord(result.output));
  else console.log(`Created routine "${title}" (${String(asRecord(result.output).id ?? "")}).`);
  return EXIT_SUCCESS;
}

async function runUpdate(args: string[]): Promise<number> {
  const command = "draft routines update";
  const flags = parseFlags(args);
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, UPDATE_USAGE);
  if (flags.switches.has("notify") && flags.switches.has("no-notify")) return usage(command, json, "give --notify or --no-notify, not both");
  if (flags.values["post-channels"] !== undefined && flags.switches.has("no-post")) return usage(command, json, "give --post-channels or --no-post, not both");

  const prompt = await loadPrompt(flags);
  if (prompt.error) return usage(command, json, prompt.error);
  const badChoice = choiceError("harness", flags.values.harness, HARNESSES) ?? choiceError("preset", flags.values.preset, PRESETS);
  if (badChoice) return usage(command, json, badChoice);

  const patch: Record<string, unknown> = {};
  for (const key of PATCH_FIELDS) if (flags.values[key] !== undefined) patch[key] = flags.values[key];
  if (prompt.text !== undefined) patch.prompt = prompt.text;
  if (flags.switches.has("notify")) patch.canNotify = true;
  if (flags.switches.has("no-notify")) patch.canNotify = false;
  if (flags.switches.has("no-post")) patch.postChannels = null;
  else if (flags.values["post-channels"] !== undefined) patch.postChannels = postChannelsValue(flags.values["post-channels"]);
  if (flags.events.length) patch.events = flags.events;
  if (Object.keys(patch).length === 0) return usage(command, json, `nothing to update. ${UPDATE_USAGE}`);

  const result = await callTool(command, json, "routines.update", { taskId: id, patch });
  if (typeof result === "number") return result;
  if (json) printJsonLine(asRecord(result.output));
  else console.log(`Updated routine ${id}.`);
  return EXIT_SUCCESS;
}

// Runs a subcommand that takes one routine id and calls one tool with { taskId }.
async function runWithId(command: string, args: string[], tool: string, render: (output: unknown, id: string, json: boolean) => void): Promise<number> {
  const flags = parseFlags(args);
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, `usage: ${command} <id> [--json]`);

  const result = await callTool(command, json, tool, { taskId: id });
  if (typeof result === "number") return result;
  render(result.output, id, json);
  return EXIT_SUCCESS;
}

function renderDeleted(output: unknown, id: string, json: boolean): void {
  if (json) printJsonLine(asRecord(output));
  else console.log(`Deleted routine ${id}.`);
}

function renderStarted(output: unknown, id: string, json: boolean): void {
  if (json) printJsonLine(asRecord(output));
  else console.log(`Started a run of ${id}.`);
}

function renderRuns(output: unknown, _id: string, json: boolean): void {
  if (json) {
    printJsonLine(asRecord(output));
    return;
  }
  const runs = (asRecord(output).runs as Array<{ startedAt: string; status: string; result: string | null }> | undefined) ?? [];
  if (runs.length === 0) console.log("No runs yet.");
  for (const run of runs) console.log(`${run.startedAt}  ${run.status}  ${run.result ?? ""}`);
}

function printRoutinesHelp(): void {
  console.log(`${bold("draft routines")} — scheduled background tasks in the workspace.`);
  console.log("");
  console.log("Usage:");
  console.log(`  draft routines list [--json]   ${dim("List routines with schedule, cron, enabled state, next run")}`);
  console.log(`  draft routines show <id> [--json]   ${dim("Show one routine")}`);
  console.log(`  draft routines create --title <t> --prompt <text>|--prompt-file <path> --harness <claude|codex> --preset <preset> [options]`);
  console.log(`  draft routines update <id> [options]   ${dim("Change a routine. Pass only the fields to change")}`);
  console.log(`  draft routines delete <id>   ${dim("Delete a routine")}`);
  console.log(`  draft routines run <id>   ${dim("Start a run now")}`);
  console.log(`  draft routines runs <id> [--json]   ${dim("List recent runs")}`);
  console.log("");
  console.log("Options for create and update:");
  console.log(`  --model <id>  --time HH:MM  --weekday <sun..sat>  --timezone <zone>  --on fireflies.meeting_summarized`);
  console.log(`  --notify  --post-channels joined|#a,#b   ${dim("create and update; update also takes --no-notify and --no-post")}`);
  console.log(`  Presets: ${PRESETS.join(", ")}`);
}

const SUBCOMMANDS = new Map<string, (args: string[]) => Promise<number>>([
  ["list", runList],
  ["show", runShow],
  ["create", runCreate],
  ["update", runUpdate],
  ["delete", (args) => runWithId("draft routines delete", args, "routines.delete", renderDeleted)],
  ["run", (args) => runWithId("draft routines run", args, "routines.run", renderStarted)],
  ["runs", (args) => runWithId("draft routines runs", args, "routines.runs", renderRuns)],
]);

export async function runRoutines(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    printRoutinesHelp();
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    printRoutinesHelp();
    return EXIT_SUCCESS;
  }
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    console.error(red(`draft routines: unknown subcommand "${sub}". Use list, show, create, update, delete, run or runs.`));
    return EXIT_USAGE_ERROR;
  }
  return handler(rest);
}
