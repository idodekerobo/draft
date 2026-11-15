// commands/routines.ts — draft routines <command>. Each command calls one routines.* tool as the signed-in person.
//
// `--wait` is CLI-only. Over MCP, an agent polls routines.runs with the run id.

import { readFile } from "node:fs/promises";
import { ROUTINE_EVENT_NAMES, ROUTINE_PRESETS, ROUTINE_TRIGGERS, ROUTINE_WEEKDAYS } from "draft-core/routine-triggers";
import { callPersonTool, type FetchErrorCode, type RoutineAgent, type RoutineRun, type RoutineSummary, type ToolCallResult } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine, type ErrorPayload } from "../utils/json-output.ts";
import { bold, dim, red, yellow } from "../utils/output.ts";

const HARNESSES = ["claude", "codex"];
const GITHUB_ACCESS = ["read", "write"];
const CONNECTABLE = new Set(["fireflies", "granola", "github", "linear", "slack", "claude-code"]);
const SCHEDULE_KEYS = ["time", "weekday", "timezone"];
const PATCH_KEYS = ["title", "harness", "model", "preset", ...SCHEDULE_KEYS];
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const WAIT_INTERVAL_MS = 5_000;
const WAIT_TIMEOUT_MS = 30 * 60_000;

const CREATE_VALUES = ["title", "prompt", "prompt-file", "harness", "model", "preset", "time", "weekday", "timezone", "on", "post-channels", "github", "github-access"];
const CREATE_SWITCHES = ["notify", "no-schedule", "disabled"];
const UPDATE_SWITCHES = ["notify", "no-notify", "no-post", "no-github", "schedule", "no-schedule", "no-triggers", "enable", "disable"];

const LIST_USAGE = "usage: draft routines list [<id>] [--json]";
const CREATE_USAGE = "usage: draft routines create --title <text> (--prompt <text> | --prompt-file <path>) --harness <claude|codex> --preset <preset> [options]. Run `draft routines create --help`.";
const UPDATE_USAGE = "usage: draft routines update <id> [options]. Run `draft routines update --help`.";

interface FlagSpec {
  values: string[];
  switches: string[];
}

interface Flags {
  positionals: string[];
  values: Record<string, string>;
  events: string[];
  switches: Set<string>;
  error?: string;
}

type ToolOutcome = { output: unknown } | number;
type ToolFailure = Extract<ToolCallResult, { ok: false }>;

interface RoutineOptions {
  triggers: { event: string; provider: string; label: string; connected: boolean }[];
  schedule: { presets: { preset: string; meaning: string }[]; weekdays: string[]; time: string; onSchedule: string };
  agents: { harness: string; status: string; models: { model: string; label: string }[] }[];
  access: { slackChannels: unknown; githubRepos: unknown };
  notes?: string;
}

function parseFlags(args: string[], spec: FlagSpec): Flags {
  const flags: Flags = { positionals: [], values: {}, events: [], switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      flags.positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === "json" || spec.switches.includes(name)) {
      flags.switches.add(name);
      continue;
    }
    if (!spec.values.includes(name)) return { ...flags, error: `unknown flag: ${arg}` };
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

function refusalPayload(code: string, message: string): ErrorPayload {
  const provider = code.match(/^(.+)_not_connected$/)?.[1];
  return provider && CONNECTABLE.has(provider) ? errorPayload(code, message, `draft integrations connect ${provider}`) : errorPayload(code, message);
}

function failurePayload(result: ToolFailure): ErrorPayload {
  if (result.toolStatus) return refusalPayload(result.refusal ?? result.code, result.message ?? "The routine request did not work.");
  return transportError(result.code);
}

function fail(command: string, json: boolean, payload: ErrorPayload, exitCode = EXIT_OPERATIONAL_ERROR): number {
  if (json) {
    printJsonLine(payload);
    return exitCode;
  }
  console.error(red(`${command}: ${payload.message}`));
  if (payload.action) console.error(payload.code.endsWith("_not_connected") ? `Connect it with: ${payload.action}` : `Run \`${payload.action}\`.`);
  return exitCode;
}

function usage(command: string, json: boolean, message: string): number {
  return fail(command, json, errorPayload("invalid_usage", message), EXIT_USAGE_ERROR);
}

async function callTool(command: string, json: boolean, tool: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await callPersonTool(tool, input);
  if (result.ok) return { output: result.output };
  return fail(command, json, failurePayload(result));
}

function choiceError(name: string, value: string | undefined, choices: readonly string[]): string | undefined {
  if (value === undefined || choices.includes(value)) return undefined;
  return `--${name} must be one of: ${choices.join(", ")}`;
}

function eventsError(events: string[]): string | undefined {
  const bad = events.find((event) => !(ROUTINE_EVENT_NAMES as readonly string[]).includes(event));
  return bad ? `unknown trigger "${bad}". Triggers: ${ROUTINE_EVENT_NAMES.join(", ")}` : undefined;
}

function githubError(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const repos = splitList(raw);
  if (repos.length === 0) return "--github needs at least one owner/repo";
  const bad = repos.find((repo) => !REPO_PATTERN.test(repo));
  return bad ? `--github must list owner/repo names. Got "${bad}".` : undefined;
}

function checkChoices(flags: Flags): string | undefined {
  return choiceError("harness", flags.values.harness, HARNESSES)
    ?? choiceError("preset", flags.values.preset, ROUTINE_PRESETS)
    ?? choiceError("weekday", flags.values.weekday, ROUTINE_WEEKDAYS)
    ?? choiceError("github-access", flags.values["github-access"], GITHUB_ACCESS)
    ?? eventsError(flags.events)
    ?? githubError(flags.values.github);
}

function flagConflict(flags: Flags): string | undefined {
  const s = flags.switches;
  for (const [a, b] of [["notify", "no-notify"], ["schedule", "no-schedule"], ["enable", "disable"]] as const) {
    if (s.has(a) && s.has(b)) return `give --${a} or --${b}, not both`;
  }
  if (flags.values["post-channels"] !== undefined && s.has("no-post")) return "give --post-channels or --no-post, not both";
  if (flags.values.github !== undefined && s.has("no-github")) return "give --github or --no-github, not both";
  if (s.has("no-triggers") && flags.events.length) return "give --on or --no-triggers, not both";
  if (flags.values["github-access"] !== undefined && flags.values.github === undefined) return "--github-access needs --github";
  return undefined;
}

function scheduleFields(values: Record<string, string>, preset: string): Record<string, string> {
  const fields: Record<string, string> = { preset };
  for (const key of SCHEDULE_KEYS) if (values[key] !== undefined) fields[key] = values[key]!;
  return fields;
}

function postChannelsValue(raw: string): "joined" | string[] {
  return raw === "joined" ? "joined" : splitList(raw);
}

function githubValue(flags: Flags): { repos: string[]; access: string } {
  return { repos: splitList(flags.values.github!), access: flags.values["github-access"] ?? "read" };
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

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function describeRun(run: RoutineRun): string {
  const detail = run.status === "skipped" ? run.skipReason : run.result;
  return detail ? `${run.status}: ${oneLine(detail)}` : run.status;
}

function startedByLabel(start: RoutineRun["startedBy"]): string {
  if (start.type === "schedule") return "Schedule";
  if (start.type === "run_now") return "Run now";
  return ROUTINE_TRIGGERS.find((trigger) => trigger.event === start.event)?.label ?? start.event;
}

function whenText(routine: RoutineSummary): string {
  if (routine.agent?.onSchedule === false) return "Schedule off (runs on triggers and Run now only)";
  const zone = routine.scheduleDescription.includes(routine.timezone) ? "" : ` (${routine.timezone})`;
  return `${routine.scheduleDescription}${zone}`;
}

function accessLines(agent: RoutineAgent): string[] {
  const posting = agent.postChannels === "joined"
    ? "any channel Draft's bot is in"
    : agent.postChannels?.length ? agent.postChannels.join(", ") : "off";
  const github = agent.github ? `${agent.github.repos.join(", ")} (${agent.github.access})` : "off";
  return [
    "Draft: reads context",
    `Slack posting: ${posting}`,
    `Messages teammates: ${agent.canNotify ? "yes" : "no"}`,
    `GitHub: ${github}`,
  ];
}

function missingLine(provider: string): string {
  const hint = CONNECTABLE.has(provider) ? ` Connect it with: draft integrations connect ${provider}` : "";
  return `  ${yellow("missing connection")}: ${provider}. Its triggers or access will not work.${hint}`;
}

function formatRoutine(routine: RoutineSummary, detail: boolean): string {
  const agent = routine.agent;
  const lines = [`${bold(routine.title)} — ${routine.enabled ? "enabled" : "disabled"}`, `  id: ${routine.id}`];
  if (!agent) {
    lines.push(`  built-in routine (${routine.taskType})`, `  when: ${whenText(routine)}`, `  next run: ${routine.nextRunAt ?? "none scheduled"}`);
    return lines.join("\n");
  }
  lines.push(
    `  agent: ${agent.harness}, ${agent.model ?? "default model"}`,
    `  when: ${whenText(routine)}`,
    `  triggers: ${agent.events?.length ? agent.events.join(", ") : "none"}`,
    "  access:",
    ...accessLines(agent).map((line) => `    ${line}`),
    ...agent.missingConnections.map(missingLine),
    `  next run: ${routine.nextRunAt ?? "none scheduled"}`,
    `  last run: ${agent.lastRun ? `${agent.lastRun.startedAt}  ${describeRun(agent.lastRun)}` : "none yet"}`,
  );
  if (detail) {
    lines.push(`  created by: ${agent.createdByName ?? "unknown"}`, `  updated by: ${routine.updatedByName ?? "unknown"}`, "  prompt:");
    lines.push(...agent.prompt.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}

function printSaved(output: unknown, json: boolean, heading: string): number {
  if (json) printJsonLine(asRecord(output));
  else {
    console.log(heading);
    console.log(formatRoutine(asRecord(output).routine as RoutineSummary, true));
  }
  return EXIT_SUCCESS;
}

async function runList(args: string[]): Promise<number> {
  const command = "draft routines list";
  const flags = parseFlags(args, { values: [], switches: [] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  if (flags.positionals.length > 1) return usage(command, json, LIST_USAGE);
  const [taskId] = flags.positionals;

  const result = await callTool(command, json, "routines.list", taskId ? { taskId } : {});
  if (typeof result === "number") return result;
  const output = asRecord(result.output);
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  if (taskId) {
    const routine = output.routine as RoutineSummary | undefined;
    if (!routine) return fail(command, json, errorPayload("not_found", "Routine not found."));
    console.log(formatRoutine(routine, true));
    return EXIT_SUCCESS;
  }
  const routines = (output.routines as RoutineSummary[] | undefined) ?? [];
  console.log(routines.length ? routines.map((routine) => formatRoutine(routine, false)).join("\n\n") : "No routines found.");
  return EXIT_SUCCESS;
}

// Hidden alias for `list <id>`.
async function runShow(args: string[]): Promise<number> {
  if (!args.some((arg) => !arg.startsWith("--"))) return usage("draft routines show", args.includes("--json"), LIST_USAGE);
  return runList(args);
}

function namesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const row = asRecord(item);
      return typeof row.name === "string" ? `#${row.name.replace(/^#/, "")}` : String(row.id ?? "");
    })
    .filter(Boolean);
}

function section(title: string, lines: string[]): string {
  return [bold(title), ...lines].join("\n");
}

function formatOptions(options: RoutineOptions): string {
  const byProvider = new Map<string, RoutineOptions["triggers"]>();
  for (const trigger of options.triggers) byProvider.set(trigger.provider, [...(byProvider.get(trigger.provider) ?? []), trigger]);
  const triggerLines = [...byProvider].flatMap(([provider, triggers]) => [
    `  ${provider}${triggers[0]!.connected ? "" : yellow(" (not connected)")}`,
    ...triggers.map((trigger) => `    ${trigger.event}  ${trigger.label}`),
  ]);

  const listOrNone = (names: string[] | null, unavailable: string): string[] => {
    if (names === null) return [`  ${unavailable}`];
    return names.length ? names.map((name) => `  ${name}`) : ["  none"];
  };

  const sections = [
    section("Triggers", triggerLines),
    section("Schedule presets", [
      ...options.schedule.presets.map((preset) => `  ${preset.preset}  ${preset.meaning}`),
      `  Weekdays: ${options.schedule.weekdays.join(", ")}`,
      `  Time: ${options.schedule.time}`,
      `  Schedule off: ${options.schedule.onSchedule}`,
    ]),
    section("Agents", options.agents.flatMap((agent) => [
      `  ${agent.harness} (${agent.status})`,
      `    models: ${agent.models.map((model) => `${model.model} (${model.label})`).join(", ") || "none"}`,
    ])),
    section("Slack channels", listOrNone(namesOf(options.access.slackChannels), "unavailable right now")),
    section("GitHub repos", listOrNone(namesOf(options.access.githubRepos), "unavailable right now")),
  ];
  if (options.notes) sections.push(dim(options.notes));
  return sections.join("\n\n");
}

async function runOptions(args: string[]): Promise<number> {
  const command = "draft routines options";
  const flags = parseFlags(args, { values: [], switches: [] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  if (flags.positionals.length) return usage(command, json, "usage: draft routines options [--json]");

  const result = await callTool(command, json, "routines.options", {});
  if (typeof result === "number") return result;
  if (json) printJsonLine(asRecord(result.output));
  else console.log(formatOptions(result.output as RoutineOptions));
  return EXIT_SUCCESS;
}

async function runCreate(args: string[]): Promise<number> {
  const command = "draft routines create";
  const flags = parseFlags(args, { values: CREATE_VALUES, switches: CREATE_SWITCHES });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  if (flags.positionals.length) return usage(command, json, `unexpected argument: ${flags.positionals[0]}`);

  const prompt = await loadPrompt(flags);
  if (prompt.error) return usage(command, json, prompt.error);
  const { title, harness } = flags.values;
  const noSchedule = flags.switches.has("no-schedule");
  const preset = flags.values.preset ?? (noSchedule ? "daily" : undefined);
  if (!title || !harness || !preset || !prompt.text) return usage(command, json, CREATE_USAGE);
  const problem = checkChoices(flags) ?? flagConflict(flags);
  if (problem) return usage(command, json, problem);

  const body: Record<string, unknown> = {
    title,
    prompt: prompt.text,
    harness,
    model: flags.values.model ?? null,
    schedule: scheduleFields(flags.values, preset),
  };
  if (flags.switches.has("notify")) body.canNotify = true;
  if (flags.values["post-channels"] !== undefined) body.postChannels = postChannelsValue(flags.values["post-channels"]);
  if (flags.values.github !== undefined) body.github = githubValue(flags);
  if (flags.events.length) body.events = flags.events;
  if (noSchedule) body.onSchedule = false;
  if (flags.switches.has("disabled")) body.enabled = false;

  const result = await callTool(command, json, "routines.create", body);
  if (typeof result === "number") return result;
  return printSaved(result.output, json, "Created routine.");
}

function buildPatch(flags: Flags, promptText: string | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) if (flags.values[key] !== undefined) patch[key] = flags.values[key];
  if (promptText !== undefined) patch.prompt = promptText;
  const s = flags.switches;
  if (s.has("notify")) patch.canNotify = true;
  if (s.has("no-notify")) patch.canNotify = false;
  if (s.has("no-post")) patch.postChannels = null;
  else if (flags.values["post-channels"] !== undefined) patch.postChannels = postChannelsValue(flags.values["post-channels"]);
  if (s.has("no-github")) patch.github = null;
  else if (flags.values.github !== undefined) patch.github = githubValue(flags);
  if (s.has("schedule")) patch.onSchedule = true;
  if (s.has("no-schedule")) patch.onSchedule = false;
  if (s.has("no-triggers")) patch.events = [];
  else if (flags.events.length) patch.events = flags.events;
  if (s.has("enable")) patch.enabled = true;
  if (s.has("disable")) patch.enabled = false;
  return patch;
}

async function runUpdate(args: string[]): Promise<number> {
  const command = "draft routines update";
  const flags = parseFlags(args, { values: CREATE_VALUES, switches: UPDATE_SWITCHES });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, UPDATE_USAGE);
  const conflict = flagConflict(flags);
  if (conflict) return usage(command, json, conflict);

  const prompt = await loadPrompt(flags);
  if (prompt.error) return usage(command, json, prompt.error);
  const problem = checkChoices(flags);
  if (problem) return usage(command, json, problem);

  const patch = buildPatch(flags, prompt.text);
  if (Object.keys(patch).length === 0) return usage(command, json, `nothing to change. ${UPDATE_USAGE}`);
  const result = await callTool(command, json, "routines.update", { taskId: id, patch });
  if (typeof result === "number") return result;
  return printSaved(result.output, json, "Updated routine.");
}

async function runDelete(args: string[]): Promise<number> {
  const command = "draft routines delete";
  const flags = parseFlags(args, { values: [], switches: [] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, "usage: draft routines delete <id> [--json]");

  const result = await callTool(command, json, "routines.delete", { taskId: id });
  if (typeof result === "number") return result;
  if (json) printJsonLine(asRecord(result.output));
  else console.log(`Deleted routine ${id}.`);
  return EXIT_SUCCESS;
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  readRun?: (taskId: string, runId: string) => Promise<ToolCallResult>;
}

/** Polls routines.runs until the run leaves "running". Returns the run, or the error that stopped the wait. */
export async function waitForRun(
  taskId: string,
  runId: string,
  options: WaitOptions = {},
): Promise<{ run: RoutineRun } | { error: ErrorPayload }> {
  const intervalMs = options.intervalMs ?? WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
  const readRun = options.readRun ?? ((task, run) => callPersonTool("routines.runs", { taskId: task, runId: run }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await readRun(taskId, runId);
    if (!result.ok) return { error: failurePayload(result) };
    const run = asRecord(result.output).run as RoutineRun | undefined;
    if (!run) return { error: errorPayload("malformed_response", "Unexpected answer from routines.runs.") };
    if (run.status !== "running") return { run };
    if (Date.now() >= deadline) {
      const minutes = Math.round(timeoutMs / 60_000);
      return { error: errorPayload("wait_timeout", `Run ${runId} is still running after ${minutes} minutes. Check it with: draft routines runs ${taskId} --run-id ${runId}`) };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function runRun(args: string[]): Promise<number> {
  const command = "draft routines run";
  const flags = parseFlags(args, { values: [], switches: ["wait"] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  if (!id || extra.length) return usage(command, json, "usage: draft routines run <id> [--wait] [--json]");
  const wait = flags.switches.has("wait");

  const result = await callTool(command, json, "routines.run", { taskId: id });
  if (typeof result === "number") return result;
  const output = asRecord(result.output);
  const runId = typeof output.runId === "string" ? output.runId : null;

  if (!wait) {
    if (json) printJsonLine(output);
    else if (runId) console.log(`Started run ${runId} of ${id}. Check it with: draft routines runs ${id} --run-id ${runId}`);
    else console.log(`Started a run of ${id}.`);
    return EXIT_SUCCESS;
  }
  if (!runId) return fail(command, json, errorPayload("run_id_missing", "The run started, but no run id came back, so --wait cannot follow it."));
  if (!json) console.error(dim(`Waiting for run ${runId}...`));

  const waited = await waitForRun(id, runId);
  if ("error" in waited) return fail(command, json, waited.error);
  if (json) {
    printJsonLine({ run: waited.run });
  } else {
    console.log(`Run ${runId}: ${waited.run.status}`);
    const detail = waited.run.status === "skipped" ? waited.run.skipReason : waited.run.result;
    if (detail) console.log(detail);
  }
  return waited.run.status === "failed" ? EXIT_OPERATIONAL_ERROR : EXIT_SUCCESS;
}

function formatRunRow(run: RoutineRun): string {
  const head = `${run.id}  ${run.status}  ${startedByLabel(run.startedBy)}  ${run.startedAt}`;
  const detail = run.status === "skipped" ? run.skipReason : run.result;
  return detail ? `${head}\n    ${oneLine(detail)}` : head;
}

function formatRun(run: RoutineRun): string {
  const lines = [
    bold(`Run ${run.id}`),
    `  status: ${run.status}`,
    `  started by: ${startedByLabel(run.startedBy)}`,
    `  started: ${run.startedAt}`,
    `  ended: ${run.endedAt ?? "not yet"}`,
  ];
  if (run.status === "skipped") lines.push(`  skipped because: ${run.skipReason ?? "no reason given"}`);
  else if (run.result) lines.push(`  result: ${run.result}`);
  return lines.join("\n");
}

async function runRuns(args: string[]): Promise<number> {
  const command = "draft routines runs";
  const flags = parseFlags(args, { values: ["run-id", "cursor"], switches: ["transcript"] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  const runsUsage = "usage: draft routines runs <id> [--run-id <id>] [--transcript] [--cursor <n>] [--json]";
  if (!id || extra.length) return usage(command, json, runsUsage);

  const runId = flags.values["run-id"];
  const transcript = flags.switches.has("transcript");
  const cursor = flags.values.cursor;
  if (transcript && runId === undefined) return usage(command, json, "--transcript needs --run-id");
  if (cursor !== undefined && !transcript) return usage(command, json, "--cursor needs --transcript");
  if (cursor !== undefined && !/^\d+$/.test(cursor)) return usage(command, json, "--cursor must be a whole number");

  const input: Record<string, unknown> = { taskId: id };
  if (runId !== undefined) input.runId = runId;
  if (transcript) input.transcript = true;
  if (cursor !== undefined) input.cursor = Number(cursor);
  const result = await callTool(command, json, "routines.runs", input);
  if (typeof result === "number") return result;
  const output = asRecord(result.output);
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }

  if (transcript) {
    const { lines, nextCursor } = (output.transcript ?? { lines: [], nextCursor: null }) as { lines: string[]; nextCursor: number | null };
    console.log(lines.length ? lines.join("\n") : "No transcript lines.");
    if (nextCursor !== null) console.log(dim(`More: draft routines runs ${id} --run-id ${runId} --transcript --cursor ${nextCursor}`));
  } else if (runId !== undefined) {
    console.log(formatRun(output.run as RoutineRun));
  } else {
    const runs = (output.runs as RoutineRun[] | undefined) ?? [];
    console.log(runs.length ? runs.map(formatRunRow).join("\n") : "No runs yet.");
  }
  return EXIT_SUCCESS;
}

const TOP_HELP = `${bold("draft routines")} — scheduled background tasks in the workspace.

Commands:
  list [<id>] [--json]      List routines, or show one with its full prompt
  options [--json]          Show triggers, schedule presets, agents, Slack channels and GitHub repos
  create                    Create a routine
  update <id>               Change a routine. Pass only the fields to change
  delete <id>               Delete a routine
  run <id> [--wait]         Start a run now
  runs <id>                 List runs, or show one run or its transcript

Run \`draft routines <command> --help\` for its flags.`;

const LIST_HELP = `usage: draft routines list [<id>] [--json]

  <id>      Show one routine, with its full prompt and who created or changed it.
  --json    Print the answer as JSON.

Examples:
  draft routines list
  draft routines list <id>`;

const OPTIONS_HELP = `usage: draft routines options [--json]

Shows what a routine can use: triggers (and which ones are connected), schedule presets,
agents, Slack channels and GitHub repos. Run it before create or update.

  --json    Print the answer as JSON.

Example:
  draft routines options`;

const TRIGGER_LIST = ROUTINE_TRIGGERS.map((trigger) => `  ${trigger.event}  ${trigger.label}`).join("\n");
const PRESET_LIST = ROUTINE_PRESETS.join(", ");

const SHARED_FLAGS = `  --title <text>           Name of the routine. Up to 120 characters.
  --prompt <text>          What the agent does on each run.
  --prompt-file <path>     Read the prompt from a file. Use this or --prompt, not both.
  --harness <harness>      claude or codex.
  --model <id>             Model for the harness. See \`draft routines options\`.
  --preset <preset>        When it runs on its schedule: ${PRESET_LIST}.
  --time HH:MM             Time of day on a 24-hour clock. For daily, weekdays and weekly.
  --weekday <day>          sun, mon, tue, wed, thu, fri or sat. For weekly.
  --timezone <zone>        IANA zone, such as America/New_York.
  --on <trigger>           Also run on this event. Repeat the flag or pass a comma list.
  --notify                 Let the agent message teammates on Slack.
  --post-channels <list>   joined (any channel Draft is in), or channel names such as #general,#eng.
  --github <repos>         owner/repo, or a comma list, the agent can use.
  --github-access <access> read (default) or write. write lets it open pull requests.`;

const TRIGGERS_SECTION = `Triggers for --on:
${TRIGGER_LIST}`;

const CREATE_HELP = `usage: draft routines create --title <text> (--prompt <text> | --prompt-file <path>) --harness <harness> --preset <preset> [options]

${SHARED_FLAGS}
  --no-schedule            Run only on triggers and Run now. The schedule is kept for later.
                           With this flag, --preset is optional and defaults to daily.
  --disabled               Save the routine turned off.
  --json                   Print the answer as JSON.

${TRIGGERS_SECTION}

Examples:
  draft routines create --title "Weekday digest" --prompt-file digest.md --harness claude --preset weekdays --time 09:00 --timezone America/New_York
  draft routines create --title "Review PRs" --prompt "Review each new pull request." --harness claude --no-schedule --on github.pull_request_opened --github acme/app`;

const UPDATE_HELP = `usage: draft routines update <id> [options]

Changes only the fields you pass. Other fields stay as they are.
--on replaces the whole trigger list. --github replaces the repo list.

${SHARED_FLAGS}
  --no-notify              Stop letting the agent message teammates on Slack.
  --no-post                Stop posting in Slack.
  --no-github              Remove GitHub access.
  --no-triggers            Remove every trigger.
  --schedule               Turn the schedule on.
  --no-schedule            Turn the schedule off. Only triggers and Run now start the routine.
  --enable                 Turn the routine on.
  --disable                Turn the routine off.
  --json                   Print the answer as JSON.

${TRIGGERS_SECTION}

Examples:
  draft routines update <id> --time 10:30
  draft routines update <id> --no-schedule --on linear.issue_completed`;

const DELETE_HELP = `usage: draft routines delete <id> [--json]

Deletes a routine. Its past runs stay readable in the app.

  --json    Print the answer as JSON.

Example:
  draft routines delete <id>`;

const RUN_HELP = `usage: draft routines run <id> [--wait] [--json]

Starts a run now and prints the run id.

  --wait    Wait for the run to finish, then print its status and result.
            Checks every 5 seconds, for up to 30 minutes. Exits 1 if the run failed.
  --json    Print the answer as JSON. With --wait, prints { run }.

--wait is CLI-only. Over MCP, an agent polls routines.runs with the run id.

Examples:
  draft routines run <id>
  draft routines run <id> --wait`;

const RUNS_HELP = `usage: draft routines runs <id> [--run-id <id>] [--transcript] [--cursor <n>] [--json]

Lists the newest runs. Add --run-id to see one run.

  --run-id <id>    Show one run.
  --transcript     With --run-id: show what the agent did, a page at a time.
  --cursor <n>     With --transcript: start at the cursor from the last page.
  --json           Print the answer as JSON.

Examples:
  draft routines runs <id>
  draft routines runs <id> --run-id <run-id> --transcript`;

const SUBCOMMANDS = new Map<string, { run: (args: string[]) => Promise<number>; help: string }>([
  ["list", { run: runList, help: LIST_HELP }],
  ["show", { run: runShow, help: LIST_HELP }],
  ["options", { run: runOptions, help: OPTIONS_HELP }],
  ["create", { run: runCreate, help: CREATE_HELP }],
  ["update", { run: runUpdate, help: UPDATE_HELP }],
  ["delete", { run: runDelete, help: DELETE_HELP }],
  ["run", { run: runRun, help: RUN_HELP }],
  ["runs", { run: runRuns, help: RUNS_HELP }],
]);
const COMMAND_NAMES = ["list", "options", "create", "update", "delete", "run", "runs"];

export async function runRoutines(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    console.log(TOP_HELP);
    return EXIT_USAGE_ERROR;
  }
  if (sub === "--help" || sub === "-h") {
    console.log(TOP_HELP);
    return EXIT_SUCCESS;
  }
  const command = SUBCOMMANDS.get(sub);
  if (!command) {
    console.error(red(`draft routines: unknown command "${sub}". Use ${COMMAND_NAMES.join(", ")}.`));
    return EXIT_USAGE_ERROR;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(command.help);
    return EXIT_SUCCESS;
  }
  return command.run(rest);
}
