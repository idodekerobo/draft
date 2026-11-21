// integrations/tool-commands.ts — draft connections read | post | disconnect, and connect --channels.
// Each command calls one connections.* tool. The provider is a flag, and flag names match the tool's input fields.

import { HOSTED_CONNECTION_PROVIDERS } from "draft-core/integrations/hosted-connections";
import { callPersonTool, runModeErrorMessage, type ToolCallResult } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, red } from "../utils/output.ts";
import { toBackendProvider, type ConnectCliProvider } from "./agent.ts";
import { PROVIDER_LABELS } from "./types.ts";

const PROVIDER_LIST = HOSTED_CONNECTION_PROVIDERS.join(", ");

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
export function takeProviderFlag(args: readonly string[]): { provider?: ConnectCliProvider; rest: string[]; error?: string } {
  const taken = takeValueFlag(args, "--provider");
  if (taken.error) return { rest: taken.rest, error: taken.error };
  if (taken.value === undefined) return { rest: taken.rest };
  if (!(HOSTED_CONNECTION_PROVIDERS as readonly string[]).includes(taken.value)) {
    return { rest: taken.rest, error: `unknown provider "${taken.value}". Providers: ${PROVIDER_LIST}` };
  }
  return { provider: taken.value as ConnectCliProvider, rest: taken.rest };
}

function fail(command: string, json: boolean, code: string, message: string, exitCode: number, action?: string): number {
  if (json) printJsonLine(errorPayload(code, message, action));
  else console.error(red(`${command}: ${message}${action ? ` Run \`${action}\`.` : ""}`));
  return exitCode;
}

function usage(command: string, json: boolean, message: string): number {
  return fail(command, json, "invalid_usage", `${message}. See \`${command} --help\`.`, EXIT_USAGE_ERROR);
}

function toolFailure(command: string, json: boolean, result: Extract<ToolCallResult, { ok: false }>): number {
  if (result.toolStatus) return fail(command, json, result.refusal ?? result.code, result.message ?? "The request did not work.", EXIT_OPERATIONAL_ERROR);
  const notSignedIn = result.code === "not_authenticated";
  const message = runModeErrorMessage(result.code) ?? (notSignedIn ? "Not signed in." : "Could not reach Draft. Retry shortly.");
  return fail(command, json, result.code, message, EXIT_OPERATIONAL_ERROR, notSignedIn ? "draft auth login" : undefined);
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function requireProvider(command: string, json: boolean, parsed: ParsedFlags): ConnectCliProvider | number {
  const provider = parsed.values["--provider"];
  if (!provider) return usage(command, json, `--provider is required (${PROVIDER_LIST})`);
  if (!(HOSTED_CONNECTION_PROVIDERS as readonly string[]).includes(provider)) return usage(command, json, `unknown provider "${provider}". Providers: ${PROVIDER_LIST}`);
  return provider as ConnectCliProvider;
}

function formatTime(ts: unknown): string {
  const seconds = typeof ts === "string" ? Number(ts) : typeof ts === "number" ? ts : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
}

export async function runConnectionsRead(args: string[]): Promise<number> {
  const command = "draft connections read";
  const json = args.includes("--json");
  const parsed = parseFlags(args, { "--provider": "value", "--channel": "value", "--limit": "value", "--json": "boolean" });
  if (parsed.error) return usage(command, json, parsed.error);
  const provider = requireProvider(command, json, parsed);
  if (typeof provider === "number") return provider;
  const channel = parsed.values["--channel"];
  if (!channel) return usage(command, json, "--channel is required");
  const limitText = parsed.values["--limit"];
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) return usage(command, json, "--limit must be a whole number from 1 to 50");

  const result = await callPersonTool("connections.read", { provider: toBackendProvider(provider), channel, ...(limit === undefined ? {} : { limit }) });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) {
    printJsonLine(output);
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
  const provider = requireProvider(command, json, parsed);
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

/** Sets the channels the Slack bot joins, for a Slack connection that already exists. */
export async function runConnectChannels(provider: ConnectCliProvider, channelsArg: string, json: boolean): Promise<number> {
  const command = "draft connections connect";
  if (provider !== "slack") return usage(command, json, "--channels applies to slack only");
  const channels = channelsArg.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!channels.length) return usage(command, json, "--channels needs at least one channel id or #name");

  const result = await callPersonTool("connections.connect", { provider: toBackendProvider(provider), channels });
  if (!result.ok) return toolFailure(command, json, result);
  const output = record(result.output) ?? {};
  if (json) printJsonLine(output);
  else console.log(typeof output.message === "string" ? output.message : "Slack channels updated.");
  const failed = record(output.channels)?.failed;
  return Array.isArray(failed) && failed.length > 0 ? EXIT_OPERATIONAL_ERROR : EXIT_SUCCESS;
}
