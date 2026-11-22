// integrations/tool-commands.ts — draft connections read | post | join | leave | disconnect.
// Each command calls one connections.* tool. The provider is a flag, and flag names match the tool's input fields.

import { HOSTED_CONNECTION_PROVIDERS, SERVICE_CLI_PROVIDERS, type ServiceCliProvider } from "draft-core/integrations/hosted-connections";
import { callPersonTool, runModeErrorMessage, type ToolCallResult } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, red } from "../utils/output.ts";
import { isInteractiveTerminal, toBackendProvider, type ConnectCliProvider } from "./agent.ts";
import { channelSelector, type ChannelSelector } from "./channel-select.ts";
import { PROVIDER_LABELS } from "./types.ts";

/** "connect" names are what a provider is connected as. "service" adds Gmail and Google Drive, which connect together as google. */
type ProviderScope = "connect" | "service";
const PROVIDER_NAMES: Record<ProviderScope, readonly string[]> = { connect: HOSTED_CONNECTION_PROVIDERS, service: SERVICE_CLI_PROVIDERS };
const providerList = (scope: ProviderScope) => PROVIDER_NAMES[scope].join(", ");

type FlagKind = "value" | "boolean";
interface ParsedFlags {
  values: Record<string, string>;
  flags: Set<string>;
  error?: string;
}

/** Takes `--name value` and `--name=value` flags. Anything else, a repeated flag, or a missing value is an error. */
function parseFlags(args: readonly string[], specs: Record<string, FlagKind>): ParsedFlags {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const kind = specs[name];
    if (!kind) return { values, flags, error: arg.startsWith("-") ? `unknown flag: ${name}` : `unexpected argument: ${arg}. Flags take their value after the name, for example --provider slack` };
    if (flags.has(name)) return { values, flags, error: `${name} was given twice` };
    flags.add(name);
    if (kind === "boolean") {
      if (inline !== undefined) return { values, flags, error: `${name} takes no value` };
      continue;
    }
    const value = inline ?? args[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) return { values, flags, error: `${name} requires a value` };
    values[name] = value;
  }
  return { values, flags };
}

/** Removes one `--name value` flag from the arguments and returns its value. The rest go on to the command's own parser. */
export function takeValueFlag(args: readonly string[], name: string): { value?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== name && !arg.startsWith(`${name}=`)) {
      rest.push(arg);
      continue;
    }
    if (value !== undefined) return { rest, error: `${name} was given twice` };
    const next = arg === name ? args[++index] : arg.slice(name.length + 1);
    if (next === undefined || next === "" || next.startsWith("--")) return { rest, error: `${name} requires a value` };
    value = next;
  }
  return { value, rest };
}

/** Takes `--provider <name>` out of the arguments and checks it names a provider. */
export function takeProviderFlag(args: readonly string[], scope: ProviderScope = "service"): { provider?: ServiceCliProvider; rest: string[]; error?: string } {
  const taken = takeValueFlag(args, "--provider");
  if (taken.error) return { rest: taken.rest, error: taken.error };
  if (taken.value === undefined) return { rest: taken.rest };
  if (!PROVIDER_NAMES[scope].includes(taken.value)) {
    const together = scope === "connect" && (taken.value === "gmail" || taken.value === "google-drive") ? " Gmail and Google Drive connect together: use --provider google." : "";
    return { rest: taken.rest, error: `unknown provider "${taken.value}". Providers: ${providerList(scope)}.${together}` };
  }
  return { provider: taken.value as ServiceCliProvider, rest: taken.rest };
}

function fail(command: string, json: boolean, code: string, message: string, exitCode: number, action?: string): number {
  if (json) printJsonLine(errorPayload(code, message, action));
  else console.error(red(`${command}: ${message}${action ? ` Run \`${action}\`.` : ""}`));
  return exitCode;
}

function usage(command: string, json: boolean, message: string): number {
  return fail(command, json, "invalid_usage", `${message}. See \`${command} --help\`.`, EXIT_USAGE_ERROR);
}

export const usageError = usage;

function toolFailure(command: string, json: boolean, result: Extract<ToolCallResult, { ok: false }>): number {
  if (result.toolStatus) return fail(command, json, result.refusal ?? result.code, result.message ?? "The request did not work.", EXIT_OPERATIONAL_ERROR);
  const notSignedIn = result.code === "not_authenticated";
  const message = runModeErrorMessage(result.code) ?? (notSignedIn ? "Not signed in." : "Could not reach Draft. Retry shortly.");
  return fail(command, json, result.code, message, EXIT_OPERATIONAL_ERROR, notSignedIn ? "draft auth login" : undefined);
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function requireProvider(command: string, json: boolean, parsed: ParsedFlags, scope: "connect"): ConnectCliProvider | number;
function requireProvider(command: string, json: boolean, parsed: ParsedFlags, scope?: "service"): ServiceCliProvider | number;
function requireProvider(command: string, json: boolean, parsed: ParsedFlags, scope: ProviderScope = "service"): ServiceCliProvider | number {
  const provider = parsed.values["--provider"];
  if (!provider) return usage(command, json, `--provider is required (${providerList(scope)})`);
  if (!PROVIDER_NAMES[scope].includes(provider)) return usage(command, json, `unknown provider "${provider}". Providers: ${providerList(scope)}`);
  return provider as ServiceCliProvider;
}

function formatTime(ts: unknown): string {
  const seconds = typeof ts === "string" ? Number(ts) : typeof ts === "number" ? ts : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
}

type FieldKind = "string" | "int" | "versions";
type FlagTable = Record<string, readonly [field: string, kind: FieldKind]>;

/** Each flag is the kebab-case of the tool field it fills. */
const READ_FLAGS: FlagTable = {
  "--channel": ["channel", "string"],
  "--limit": ["limit", "int"],
  "--message-id": ["messageId", "string"],
  "--thread-id": ["threadId", "string"],
  "--attachment-id": ["attachmentId", "string"],
  "--file-id": ["fileId", "string"],
  "--version": ["version", "string"],
  "--as-of": ["asOf", "string"],
  "--include": ["include", "versions"],
  "--max-bytes": ["maxBytes", "int"],
  "--cursor": ["cursor", "string"],
};

const SEARCH_FLAGS: FlagTable = {
  "--query": ["query", "string"],
  "--since": ["since", "string"],
  "--until": ["until", "string"],
  "--limit": ["limit", "int"],
  "--cursor": ["cursor", "string"],
  "--file-id": ["fileId", "string"],
};

/** Turns the flags given into tool fields, or says what is wrong with one. */
function readFields(parsed: ParsedFlags, table: FlagTable): Record<string, unknown> | string {
  const fields: Record<string, unknown> = {};
  for (const [flag, [field, kind]] of Object.entries(table)) {
    const value = parsed.values[flag];
    if (value === undefined) continue;
    if (kind === "int") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) return `${flag} must be a whole number of 1 or more`;
      fields[field] = number;
    } else if (kind === "versions") {
      if (value !== "versions") return `${flag} takes "versions"`;
      fields[field] = ["versions"];
    } else {
      fields[field] = value;
    }
  }
  return fields;
}

/** The command that fetches the next page: the flags given, with the cursor swapped. */
function moreCommand(command: string, parsed: ParsedFlags, cursor: string): string {
  const kept = Object.entries(parsed.values).filter(([flag]) => flag !== "--cursor" && flag !== "--json");
  const withBooleans = [...parsed.flags].filter((flag) => flag === "--include-history");
  const quote = (value: string) => (/^[\w@.:/-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);
  return [command, ...kept.map(([flag, value]) => `${flag} ${quote(value)}`), ...withBooleans, `--cursor ${quote(cursor)}`].join(" ");
}

export async function runConnectionsRead(args: string[]): Promise<number> {
  const command = "draft connections read";
  const json = args.includes("--json");
  const specs: Record<string, FlagKind> = { "--provider": "value", "--json": "boolean" };
  for (const flag of Object.keys(READ_FLAGS)) specs[flag] = "value";
  const parsed = parseFlags(args, specs);
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed);
  if (typeof provider === "number") return provider;
  const channel = parsed.values["--channel"];
  if (provider === "slack" && !channel) return usage(command, json, "--channel is required");
  const fields = readFields(parsed, READ_FLAGS);
  if (typeof fields === "string") return usage(command, json, fields);
  if (provider === "slack" && fields.limit !== undefined && (fields.limit as number) > 50) return usage(command, json, "--limit must be a whole number from 1 to 50");

  const result = await callPersonTool("connections.read", { provider: toBackendProvider(provider), ...fields });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  if (provider !== "slack") {
    console.log(JSON.stringify(output, null, 2));
    if (typeof output.nextCursor === "string") console.log(dim(`More: ${moreCommand(command, parsed, output.nextCursor)}`));
    return EXIT_SUCCESS;
  }
  const resolved = record(output.channel);
  console.log(`#${String(resolved?.name ?? channel)}${resolved?.id ? ` ${dim(`(${String(resolved.id)})`)}` : ""}`);
  const messages = Array.isArray(output.messages) ? output.messages : [];
  if (!messages.length) console.log("No messages.");
  for (const entry of messages) {
    const message = record(entry) ?? {};
    const who = typeof message.user === "string" ? message.user : typeof message.username === "string" ? message.username : "bot";
    console.log(`${formatTime(message.ts)}  ${who}: ${String(message.text ?? "")}`);
  }
  if (output.has_more === true) console.log(dim("More messages exist. Read more with --limit (up to 50)."));
  return EXIT_SUCCESS;
}

const oneLine = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function runConnectionsSearch(args: string[]): Promise<number> {
  const command = "draft connections search";
  const json = args.includes("--json");
  const specs: Record<string, FlagKind> = { "--provider": "value", "--json": "boolean", "--include-history": "boolean" };
  for (const flag of Object.keys(SEARCH_FLAGS)) specs[flag] = "value";
  const parsed = parseFlags(args, specs);
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed);
  if (typeof provider === "number") return provider;
  if (!parsed.values["--query"]) return usage(command, json, "--query is required");
  const fields = readFields(parsed, SEARCH_FLAGS);
  if (typeof fields === "string") return usage(command, json, fields);
  if (fields.limit !== undefined && (fields.limit as number) > 50) return usage(command, json, "--limit must be a whole number from 1 to 50");

  const result = await callPersonTool("connections.search", { provider: toBackendProvider(provider), ...fields, ...(parsed.flags.has("--include-history") ? { includeHistory: true } : {}) });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  const results = Array.isArray(output.results) ? output.results : [];
  if (!results.length) console.log("No results.");
  for (const entry of results) {
    const hit = record(entry) ?? {};
    console.log(`${oneLine(hit.date, 16).padEnd(16)}  ${oneLine(hit.title, 60)}  ${dim(oneLine(hit.snippet, 80))}  ${dim(`(${String(hit.id ?? "")})`)}`);
  }
  if (typeof output.nextCursor === "string") console.log(dim(`More: ${moreCommand(command, parsed, output.nextCursor)}`));
  return EXIT_SUCCESS;
}

async function readText(value: string): Promise<string> {
  return value === "-" ? (await Bun.stdin.text()).replace(/\n$/, "") : value;
}

export async function runConnectionsPost(args: string[]): Promise<number> {
  const command = "draft connections post";
  const json = args.includes("--json");
  const parsed = parseFlags(args, { "--provider": "value", "--channel": "value", "--text": "value", "--json": "boolean" });
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed);
  if (typeof provider === "number") return provider;
  const channel = parsed.values["--channel"];
  if (!channel) return usage(command, json, "--channel is required");
  const rawText = parsed.values["--text"];
  if (rawText === undefined) return usage(command, json, "--text is required (use --text - to read it from stdin)");
  const text = await readText(rawText);
  if (!text.trim()) return usage(command, json, "the message is empty");

  const result = await callPersonTool("connections.post", { provider: toBackendProvider(provider), channel, text });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  console.log(`Posted in #${String(record(output.channel)?.name ?? channel)}.`);
  return EXIT_SUCCESS;
}

export async function runConnectionsDisconnect(args: string[]): Promise<number> {
  const command = "draft connections disconnect";
  const json = args.includes("--json");
  const parsed = parseFlags(args, { "--provider": "value", "--workspace-key": "boolean", "--yes": "boolean", "--json": "boolean" });
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed, "connect");
  if (typeof provider === "number") return provider;
  const workspaceKey = parsed.flags.has("--workspace-key");
  if (workspaceKey && provider !== "granola") return usage(command, json, "--workspace-key applies to granola only");
  if (provider === "claude-code") return fail(command, json, "not_supported", "Claude Code sessions are not disconnected through Draft.", EXIT_OPERATIONAL_ERROR);

  const confirmed = parsed.flags.has("--yes");
  const result = await callPersonTool("connections.disconnect", {
    provider: toBackendProvider(provider),
    ...(provider === "granola" ? { accountKind: workspaceKey ? "workspace" : "personal" } : {}),
    ...(confirmed ? { confirm: true } : {}),
  });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  const message = typeof output.message === "string" ? output.message : "";

  if (output.status === "confirmation_required") {
    const again = `draft connections disconnect --provider ${provider}${workspaceKey ? " --workspace-key" : ""} --yes`;
    if (json) printJsonLine({ ...output, provider, confirm_with: again });
    else console.error(`${message.replace(/ To go ahead, call connections\.disconnect again with .*$/, "")}\nTo go ahead, run: ${again}`);
    return EXIT_OPERATIONAL_ERROR;
  }
  if (output.status === "disconnected") {
    if (json) printJsonLine({ status: "disconnected", provider });
    else console.log(`Disconnected: ${PROVIDER_LABELS[provider]}.`);
    return EXIT_SUCCESS;
  }
  if (json) printJsonLine({ ...output, provider });
  else console.log(message || `${PROVIDER_LABELS[provider]} is not connected.`);
  return EXIT_SUCCESS;
}

export interface ChannelChangeDeps {
  callTool: typeof callPersonTool;
  interactive(): boolean;
  selector: ChannelSelector;
}

const defaultChangeDeps: ChannelChangeDeps = { callTool: callPersonTool, interactive: isInteractiveTerminal, selector: channelSelector };

const PICKER_PAGE = 100;

/** Asks a person which of the biggest public channels the bot is not in yet to join. An empty answer means none. */
async function pickChannelsToJoin(command: string, json: boolean, provider: ServiceCliProvider, deps: ChannelChangeDeps): Promise<string[] | number> {
  const listed = await deps.callTool("connections.list", { provider: toBackendProvider(provider), available: true, limit: PICKER_PAGE });
  if (!listed.ok) return toolFailure(command, json, listed);
  const entry = record((record(listed.output)?.connections as unknown[] | undefined)?.[0]);
  const page = record(entry?.available);
  const channels = (Array.isArray(page?.channels) ? page.channels : []).map((raw) => record(raw) ?? {});
  if (!page) return fail(command, json, "request_failed", String(entry?.availableError ?? "Could not list the channels."), EXIT_OPERATIONAL_ERROR);
  const notIn = channels.filter((channel) => channel.joined !== true);
  if (notIn.length === 0) {
    console.log("The bot is already in every channel listed.");
    return [];
  }
  if (page.nextCursor) console.error(dim(`Showing the ${PICKER_PAGE} biggest channels. For another, name it: ${command} --provider ${provider} --channel '#name'`));
  const picked = await deps.selector.select(notIn.map((channel) => ({ id: String(channel.id), name: String(channel.name), memberCount: Number(channel.memberCount ?? 0), isMember: false })));
  if (picked === null) return usage(command, json, `could not read a choice from the terminal. Name the channels with --channel`);
  return picked;
}

async function runChannelChange(args: string[], verb: "join" | "leave", deps: ChannelChangeDeps): Promise<number> {
  const command = `draft connections ${verb}`;
  const json = args.includes("--json");
  const parsed = parseFlags(args, { "--provider": "value", "--channel": "value", "--folder": "value", "--json": "boolean" });
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed);
  if (typeof provider === "number") return provider;

  const folderGiven = parsed.values["--folder"];
  if (folderGiven !== undefined) {
    const folders = folderGiven.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (folders.length === 0) return usage(command, json, "--folder needs at least one folder id");
    if (parsed.values["--channel"] !== undefined) return usage(command, json, "--channel and --folder cannot be used together");
    return finishChannelChange(command, json, verb, provider, { folders }, deps);
  }

  const given = parsed.values["--channel"];
  let channels = given === undefined ? [] : given.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (given !== undefined && channels.length === 0) return usage(command, json, "--channel needs at least one channel id or #name");
  if (given === undefined) {
    if (verb === "join" && provider === "slack" && !json && deps.interactive()) {
      const picked = await pickChannelsToJoin(command, json, provider, deps);
      if (typeof picked === "number") return picked;
      if (picked.length === 0) {
        console.log("No channels chosen.");
        return EXIT_SUCCESS;
      }
      channels = picked;
    } else {
      return usage(command, json, `--channel is required, with channel ids or #names separated by commas. To see which channels exist: draft connections list --provider ${provider} --available`);
    }
  }

  return finishChannelChange(command, json, verb, provider, { channels }, deps);
}

async function finishChannelChange(command: string, json: boolean, verb: "join" | "leave", provider: ServiceCliProvider, scope: { channels: string[] } | { folders: string[] }, deps: ChannelChangeDeps): Promise<number> {
  const result = await deps.callTool(`connections.${verb}`, { provider: toBackendProvider(provider), ...scope });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) printJsonLine(output);
  else console.log(typeof output.message === "string" ? output.message : verb === "join" ? "Joined." : "Left.");
  return Array.isArray(output.failed) && output.failed.length > 0 ? EXIT_OPERATIONAL_ERROR : EXIT_SUCCESS;
}

export const runConnectionsJoin = (args: string[], deps: ChannelChangeDeps = defaultChangeDeps) => runChannelChange(args, "join", deps);
export const runConnectionsLeave = (args: string[], deps: ChannelChangeDeps = defaultChangeDeps) => runChannelChange(args, "leave", deps);
