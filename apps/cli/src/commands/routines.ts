// commands/routines.ts — draft routines <command>. Each command calls one routines.* tool as the signed-in person.
//
// `--wait` is CLI-only. Over MCP, an agent polls routines.runs with the session id.

import { readFile } from "node:fs/promises";
import type { RoutineListFilter } from "draft-core/routines";
import { ROUTINE_EVENT_NAMES, ROUTINE_PRESETS, ROUTINE_TRIGGERS, ROUTINE_WEEKDAYS } from "draft-core/routine-triggers";
import { callPersonTool, type FetchErrorCode, type RoutineAgent, type RoutineRun, type RoutineSummary, type ToolCallResult } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine, type ErrorPayload } from "../utils/json-output.ts";
import { bold, dim, red, yellow } from "../utils/output.ts";

const HARNESSES = ["claude", "codex"];
const GITHUB_ACCESS = ["read", "write"];
const CONNECTABLE = new Set(["fireflies", "granola", "github", "linear", "slack", "claude-code"]);
const SCHEDULE_KEYS = ["time", "weekday", "timezone"];
const SCHEDULE_FLAGS = ["preset", ...SCHEDULE_KEYS];
const PATCH_KEYS = ["title", "harness", "model"];
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
// The same rules as ROUTINE_DURATION and the datetime check in draft-core/routines. Kept here so the CLI does not load that module at startup.
const DURATION = /^([1-9]\d{0,5})(m|h|d)$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const WAIT_INTERVAL_MS = 5_000;
const WAIT_TIMEOUT_MS = 30 * 60_000;

const CREATE_VALUES = ["title", "prompt", "prompt-file", "harness", "model", "preset", "time", "weekday", "timezone", "in", "at", "on", "post-channels", "github", "github-access"];
const CREATE_SWITCHES = ["notify", "no-schedule", "disabled"];
const UPDATE_SWITCHES = ["notify", "no-notify", "no-post", "no-github", "schedule", "no-schedule", "no-triggers", "enable", "disable"];
const LIST_SWITCHES = ["once", "upcoming", "fired", "mine"];

const LIST_USAGE = "usage: draft routines list [<id>] [--once] [--upcoming | --fired] [--mine] [--json]";
const CREATE_USAGE = "usage: draft routines create --title <text> (--prompt <text> | --prompt-file <path>) --harness <claude|codex> (--in <duration> | --at <iso-time> | --preset <preset> | --on <event>) [options]. Run `draft routines create --help`.";
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
  return provider && CONNECTABLE.has(provider) ? errorPayload(code, message, `draft connections connect ${provider}`) : errorPayload(code, message);
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

function durationError(value: string | undefined): string | undefined {
  if (value === undefined || DURATION.test(value)) return undefined;
  return "--in needs a number and m, h or d, such as 10m, 2h or 3d.";
}

function atError(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return ISO_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value)) ? undefined : "--at needs an ISO time with an offset, such as 2026-12-01T09:00:00-05:00.";
}

function checkChoices(flags: Flags): string | undefined {
  return choiceError("harness", flags.values.harness, HARNESSES)
    ?? choiceError("preset", flags.values.preset, ROUTINE_PRESETS)
    ?? choiceError("weekday", flags.values.weekday, ROUTINE_WEEKDAYS)
    ?? choiceError("github-access", flags.values["github-access"], GITHUB_ACCESS)
    ?? durationError(flags.values.in)
    ?? atError(flags.values.at)
    ?? eventsError(flags.events)
    ?? githubError(flags.values.github);
}

function hasScheduleFlags(flags: Flags): boolean {
  return SCHEDULE_FLAGS.some((name) => flags.values[name] !== undefined);
}

/** Any flag that sets how a routine repeats or what starts it, as opposed to a one-shot time. */
function hasRuleFlags(flags: Flags): boolean {
  const s = flags.switches;
  return hasScheduleFlags(flags) || flags.events.length > 0 || s.has("schedule") || s.has("no-schedule") || s.has("no-triggers");
}

function onceFlag(flags: Flags): { name: "in" | "at"; value: string } | undefined {
  if (flags.values.in !== undefined) return { name: "in", value: flags.values.in };
  if (flags.values.at !== undefined) return { name: "at", value: flags.values.at };
  return undefined;
}

/** Conflicts between the flags that set when a routine runs. Create and update share these rules. */
function whenProblem(flags: Flags): string | undefined {
  if (flags.values.in !== undefined && flags.values.at !== undefined) return "give --in or --at, not both";
  const once = onceFlag(flags);
  if (once && hasRuleFlags(flags)) return `--${once.name} runs once, so it can't be combined with --preset, --time, --weekday, --timezone, --on, --no-schedule, --schedule or --no-triggers.`;
  if (flags.switches.has("no-schedule") && hasScheduleFlags(flags)) return "--no-schedule can't be combined with --preset, --time, --weekday or --timezone.";
  return undefined;
}

/** A create needs a one-shot time, a preset, a trigger or --no-schedule. Schedule fields alone have nothing to attach to. */
function createRuleProblem(flags: Flags): string | undefined {
  if (onceFlag(flags) || flags.values.preset !== undefined || flags.switches.has("no-schedule")) return undefined;
  if (hasScheduleFlags(flags)) return "--time, --weekday and --timezone need --preset.";
  return flags.events.length ? undefined : CREATE_USAGE;
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

/** A create's when: a one-shot time, or a rule. A rule with no preset (triggers only) has no schedule. */
function createWhen(flags: Flags): Record<string, unknown> {
  const once = onceFlag(flags);
  if (once) return { [once.name]: once.value };
  const preset = flags.values.preset;
  const schedule = preset === undefined || flags.switches.has("no-schedule") ? null : scheduleFields(flags.values, preset);
  return { schedule, ...(flags.events.length ? { events: flags.events } : {}) };
}

async function readRoutine(command: string, json: boolean, id: string): Promise<RoutineSummary | number> {
  const result = await callTool(command, json, "routines.list", { taskId: id });
  if (typeof result === "number") return result;
  return (asRecord(result.output).routine as RoutineSummary | undefined) ?? fail(command, json, errorPayload("not_found", "Routine not found."));
}

/** The schedule to save after a change. The API takes the whole schedule, so fields not passed come from the routine. */
function mergedSchedule(values: Record<string, string>, current: RoutineSummary): Record<string, string> | string {
  const preset = values.preset ?? current.preset;
  if (preset === "custom") return "This routine's schedule is custom. Pass --preset to set one.";
  const stored: Record<string, string | null> = { time: current.time, weekday: current.weekday, timezone: current.timezone };
  const fields: Record<string, string> = { preset };
  for (const key of SCHEDULE_KEYS) {
    const value = values[key] ?? stored[key];
    if (value) fields[key] = value;
  }
  return fields;
}

/** An update's when, or undefined when no flag touches it. A schedule change reads the routine's current schedule first. */
async function updateWhen(command: string, json: boolean, id: string, flags: Flags): Promise<Record<string, unknown> | undefined | number> {
  const once = onceFlag(flags);
  if (once) return { [once.name]: once.value };
  if (!hasRuleFlags(flags)) return undefined;
  const when: Record<string, unknown> = {};
  if (flags.switches.has("no-schedule")) when.schedule = null;
  else if (hasScheduleFlags(flags) || flags.switches.has("schedule")) {
    const current = await readRoutine(command, json, id);
    if (typeof current === "number") return current;
    const schedule = mergedSchedule(flags.values, current);
    if (typeof schedule === "string") return usage(command, json, schedule);
    when.schedule = schedule;
  }
  if (flags.switches.has("no-triggers")) when.events = [];
  else if (flags.events.length) when.events = flags.events;
  return when;
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
  if (start.type === "manual") return "Run now";
  return ROUTINE_TRIGGERS.find((trigger) => trigger.event === start.event)?.label ?? start.event;
}

function whenText(routine: RoutineSummary): string {
  if (routine.agent?.onSchedule === false) return "Schedule off (runs on triggers and Run now only)";
  const zone = routine.scheduleDescription.includes(routine.timezone) ? "" : ` (${routine.timezone})`;
  return `${routine.scheduleDescription}${zone}`;
}

function localTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "unknown time";
}

function whenLine(routine: RoutineSummary): string {
  if (routine.kind !== "once") return whenText(routine);
  return routine.firedAt ? `Fired ${localTime(routine.firedAt)}` : `Once · ${localTime(routine.runAt)}`;
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
  const hint = CONNECTABLE.has(provider) ? ` Connect it with: draft connections connect ${provider}` : "";
  return `  ${yellow("missing connection")}: ${provider}. Its triggers or access will not work.${hint}`;
}

function formatRoutine(routine: RoutineSummary, detail: boolean): string {
  const agent = routine.agent;
  const state = `${routine.enabled ? "enabled" : "disabled"}${routine.madeByAgent ? " (made by an agent)" : ""}`;
  const lines = [`${bold(routine.title)} — ${state}`, `  id: ${routine.id}`];
  if (!agent) {
    lines.push(`  built-in routine (${routine.taskType})`, `  when: ${whenLine(routine)}`, `  next run: ${routine.nextRunAt ?? "none scheduled"}`);
    return lines.join("\n");
  }
  lines.push(
    `  agent: ${agent.harness}, ${agent.model ?? "default model"}`,
    `  when: ${whenLine(routine)}`,
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

function listFilter(flags: Flags): RoutineListFilter {
  const s = flags.switches;
  const filter: RoutineListFilter = {};
  if (s.has("once") || s.has("upcoming") || s.has("fired")) filter.kind = "once";
  if (s.has("upcoming")) filter.status = "upcoming";
  if (s.has("fired")) filter.status = "fired";
  if (s.has("mine")) filter.createdBy = "me";
  return filter;
}

async function runList(args: string[]): Promise<number> {
  const command = "draft routines list";
  const flags = parseFlags(args, { values: [], switches: LIST_SWITCHES });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  if (flags.positionals.length > 1) return usage(command, json, LIST_USAGE);
  const [taskId] = flags.positionals;
  if (flags.switches.has("upcoming") && flags.switches.has("fired")) return usage(command, json, "give --upcoming or --fired, not both");
  const filter = listFilter(flags);
  if (taskId && Object.keys(filter).length) return usage(command, json, "list filters apply to all routines. Drop the id or the filter flag.");

  const result = await callTool(command, json, "routines.list", taskId ? { taskId } : filter);
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
  if (!title || !harness || !prompt.text) return usage(command, json, CREATE_USAGE);
  const problem = checkChoices(flags) ?? flagConflict(flags) ?? whenProblem(flags) ?? createRuleProblem(flags);
  if (problem) return usage(command, json, problem);

  const body: Record<string, unknown> = {
    title,
    prompt: prompt.text,
    harness,
    model: flags.values.model ?? null,
    when: createWhen(flags),
  };
  if (flags.switches.has("notify")) body.canNotify = true;
  if (flags.values["post-channels"] !== undefined) body.postChannels = postChannelsValue(flags.values["post-channels"]);
  if (flags.values.github !== undefined) body.github = githubValue(flags);
  if (flags.switches.has("disabled")) body.enabled = false;

  const result = await callTool(command, json, "routines.create", body);
  if (typeof result === "number") return result;
  return printSaved(result.output, json, "Created routine.");
}

function buildPatch(flags: Flags, promptText: string | undefined, when: Record<string, unknown> | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) if (flags.values[key] !== undefined) patch[key] = flags.values[key];
  if (promptText !== undefined) patch.prompt = promptText;
  if (when) patch.when = when;
  const s = flags.switches;
  if (s.has("notify")) patch.canNotify = true;
  if (s.has("no-notify")) patch.canNotify = false;
  if (s.has("no-post")) patch.postChannels = null;
  else if (flags.values["post-channels"] !== undefined) patch.postChannels = postChannelsValue(flags.values["post-channels"]);
  if (s.has("no-github")) patch.github = null;
  else if (flags.values.github !== undefined) patch.github = githubValue(flags);
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
  const conflict = flagConflict(flags) ?? whenProblem(flags);
  if (conflict) return usage(command, json, conflict);

  const prompt = await loadPrompt(flags);
  if (prompt.error) return usage(command, json, prompt.error);
  const problem = checkChoices(flags);
  if (problem) return usage(command, json, problem);

  const when = await updateWhen(command, json, id, flags);
  if (typeof when === "number") return when;
  const patch = buildPatch(flags, prompt.text, when);
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
  readRun?: (taskId: string, sessionId: string) => Promise<ToolCallResult>;
}

/** Polls routines.runs until the run leaves "running". Returns the run, or the error that stopped the wait. */
export async function waitForRun(
  taskId: string,
  sessionId: string,
  options: WaitOptions = {},
): Promise<{ run: RoutineRun } | { error: ErrorPayload }> {
  const intervalMs = options.intervalMs ?? WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
  const readRun = options.readRun ?? ((task, session) => callPersonTool("routines.runs", { taskId: task, sessionId: session }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await readRun(taskId, sessionId);
    if (!result.ok) return { error: failurePayload(result) };
    const run = asRecord(result.output).run as RoutineRun | undefined;
    if (!run) return { error: errorPayload("malformed_response", "Unexpected answer from routines.runs.") };
    if (run.status !== "running") return { run };
    if (Date.now() >= deadline) {
      const minutes = Math.round(timeoutMs / 60_000);
      return { error: errorPayload("wait_timeout", `Run ${sessionId} is still running after ${minutes} minutes. Check it with: draft routines runs ${taskId} --session-id ${sessionId}`) };
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
  const sessionId = typeof output.sessionId === "string" ? output.sessionId : null;
  const queued = output.queued === true;

  // A queued run has no session id yet, so there is nothing for --wait to follow.
  if (!wait || queued) {
    if (json) printJsonLine(output);
    else if (queued) console.log("Queued: runs when the current run ends.");
    else if (sessionId) console.log(`Started run ${sessionId} of ${id}. Check it with: draft routines runs ${id} --session-id ${sessionId}`);
    else console.log(`Started a run of ${id}.`);
    return EXIT_SUCCESS;
  }
  if (!sessionId) return fail(command, json, errorPayload("session_id_missing", "The run started, but no session id came back, so --wait cannot follow it."));
  if (!json) console.error(dim(`Waiting for run ${sessionId}...`));

  const waited = await waitForRun(id, sessionId);
  if ("error" in waited) return fail(command, json, waited.error);
  if (json) {
    printJsonLine({ run: waited.run });
  } else {
    console.log(`Run ${sessionId}: ${waited.run.status}`);
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
  const flags = parseFlags(args, { values: ["session-id", "cursor"], switches: ["transcript"] });
  const json = flags.switches.has("json");
  if (flags.error) return usage(command, json, flags.error);
  const [id, ...extra] = flags.positionals;
  const runsUsage = "usage: draft routines runs <id> [--cursor <c>] [--session-id <id> [--transcript [--cursor <n>]]] [--json]";
  if (!id || extra.length) return usage(command, json, runsUsage);

  const sessionId = flags.values["session-id"];
  const transcript = flags.switches.has("transcript");
  const cursor = flags.values.cursor;
  if (transcript && sessionId === undefined) return usage(command, json, "--transcript needs --session-id");
  if (cursor !== undefined && sessionId !== undefined && !transcript) return usage(command, json, "--cursor with --session-id needs --transcript");
  if (cursor !== undefined && transcript && !/^\d+$/.test(cursor)) return usage(command, json, "a transcript --cursor is a whole number");

  const input: Record<string, unknown> = { taskId: id };
  if (sessionId !== undefined) input.sessionId = sessionId;
  if (transcript) input.transcript = true;
  if (cursor !== undefined) input.cursor = cursor;
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
    if (nextCursor !== null) console.log(dim(`More: draft routines runs ${id} --session-id ${sessionId} --transcript --cursor ${nextCursor}`));
  } else if (sessionId !== undefined) {
    console.log(formatRun(output.run as RoutineRun));
  } else {
    const runs = (output.runs as RoutineRun[] | undefined) ?? [];
    console.log(runs.length ? runs.map(formatRunRow).join("\n") : "No runs yet.");
    if (typeof output.nextCursor === "string") console.log(dim(`Older runs: draft routines runs ${id} --cursor '${output.nextCursor}'`));
  }
  return EXIT_SUCCESS;
}

const TOP_HELP = `Routines: work Draft runs once, on a schedule, or when something happens.

When a routine runs:
  Once:      draft routines create --title "Check PR" --prompt "..." --harness claude --in 2h
  Schedule:  draft routines create --title "Digest" --prompt "..." --harness claude --preset daily --time 22:00
  Event:     draft routines create --title "Triage" --prompt "..." --harness claude --on linear.issue_created
One-shots (--in / --at) are routines too. List them with \`draft routines list --once\`.

Commands:
  list [<id>] [--json]      List routines, or show one with its full prompt
  options [--json]          Show triggers, schedule presets, agents, Slack channels and GitHub repos
  create                    Create a routine
  update <id>               Change a routine. Pass only the fields to change
  delete <id>               Delete a routine
  run <id> [--wait]         Start a run now
  runs <id>                 List runs, or show one run or its transcript

Run \`draft routines <command> --help\` for its flags.`;

const LIST_HELP = `${LIST_USAGE}

  <id>          Show one routine, with its full prompt and who created or changed it.
  --once        Show the one-shot routines (--in or --at).
  --upcoming    Show the one-shots that have not run yet. Implies --once.
  --fired       Show the one-shots that have run. Implies --once.
  --mine        Show only the routines you made.
  --json        Print the answer as JSON.

One-shots are hidden by default. --once shows them; --upcoming and --fired filter them; --mine shows only yours.

Examples:
  draft routines list
  draft routines list --once --upcoming
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
  --in <duration>          Run once after 10m, 2h or 3d (at most 365 days).
  --at <iso-time>          Run once at this time, for example 2026-12-01T09:00:00-05:00.
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

const CREATE_HELP = `usage: draft routines create --title <text> (--prompt <text> | --prompt-file <path>) --harness <harness> (--in <duration> | --at <iso-time> | --preset <preset> | --on <event>) [options]

${SHARED_FLAGS}
  --no-schedule            Run only on triggers and Run now. Not with --preset or --time.
  --disabled               Save the routine turned off.
  --json                   Print the answer as JSON.

${TRIGGERS_SECTION}

Examples:
  draft routines create --title "Check PR" --prompt "Review the open pull request." --harness claude --in 2h
  draft routines create --title "Weekday digest" --prompt-file digest.md --harness claude --preset weekdays --time 09:00 --timezone America/New_York
  draft routines create --title "Review PRs" --prompt "Review each new pull request." --harness claude --no-schedule --on github.pull_request_opened --github acme/app`;

const UPDATE_HELP = `usage: draft routines update <id> [options]

Changes only the fields you pass. Other fields stay as they are.
--on replaces the whole trigger list. --github replaces the repo list.
--in / --at reschedule a one-shot, including one that already ran.

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

Starts a run now and prints the run id. If a run is already in progress, this run
is queued: it starts when that run ends, and --wait does not wait for it.

  --wait    Wait for the run to finish, then print its status and result.
            Checks every 5 seconds, for up to 30 minutes. Exits 1 if the run failed.
  --json    Print the answer as JSON. With --wait, prints { run }.

--wait is CLI-only. Over MCP, an agent polls routines.runs with the session id.

Examples:
  draft routines run <id>
  draft routines run <id> --wait`;

const RUNS_HELP = `usage: draft routines runs <id> [--cursor <c>] [--session-id <id> [--transcript [--cursor <n>]]] [--json]

Lists the newest runs, 50 at a time. Add --session-id to see one run, however old.

  --cursor <c>     Show older runs: pass the cursor printed after the last page.
  --session-id <id>  Show one run.
  --transcript     With --session-id: show what the agent did, a page at a time.
                   --cursor <n> then starts at the transcript cursor from the last page.
  --json           Print the answer as JSON, including nextCursor.

Examples:
  draft routines runs <id>
  draft routines runs <id> --cursor '<cursor from the last page>'
  draft routines runs <id> --session-id <session-id> --transcript`;

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
