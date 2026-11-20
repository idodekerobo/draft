import { runDriveFolders } from "../integrations/providers/drive.ts";
import { callPersonTool } from "../cloud-client.ts";
import { runConnectionsDisconnect, runConnectionsJoin, runConnectionsLeave, runConnectionsPost, runConnectionsRead, runConnectionsSearch, takeProviderFlag, takeValueFlag, usageError } from "../integrations/tool-commands.ts";
import { createIntegrationOutput, INTEGRATION_ERROR_REGISTRY, type IntegrationErrorCode } from "../integrations/safe-output.ts";
import { isInteractiveTerminal, parseAgentConnectArgs, runAgentConnect, toBackendProvider } from "../integrations/agent.ts";
import { integrationsGroupHelp, integrationsSubcommandHelp } from "../integrations/help.ts";
import { runGithubConnect } from "../integrations/providers/github.ts";
import { runLinearConnect } from "../integrations/providers/linear.ts";
import { runClaudeCodeConnect } from "../integrations/providers/claude-code.ts";
import { runSlackConnect } from "../integrations/providers/slack.ts";
import { runFirefliesConnect } from "../integrations/providers/fireflies.ts";
import { runGranolaConnect } from "../integrations/providers/granola.ts";
import { runGoogleConnect } from "../integrations/providers/google.ts";
import { CredentialInputError, parseCredentialSourceOptions, type CredentialSource } from "../integrations/credentials.ts";

interface ParsedListArgs {
  json: boolean;
  error?: true;
}

interface ParsedGithubConnectArgs {
  json: boolean;
  noOpen: boolean;
  error?: true;
}

function parseListArgs(args: string[]): ParsedListArgs {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const json = jsonCount > 0;
  return jsonCount <= 1 && args.every((arg) => arg === "--json")
    ? { json }
    : { json, error: true };
}

function parseGithubConnectArgs(args: string[], provider: "github" | "google" = "github"): ParsedGithubConnectArgs {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const noOpenCount = args.filter((arg) => arg === "--no-open").length;
  const json = jsonCount > 0;
  const noOpen = noOpenCount > 0;
  const valid = args[0] === provider &&
    jsonCount <= 1 &&
    noOpenCount <= 1 &&
    args.slice(1).every((arg) => arg === "--json" || arg === "--no-open");
  return valid ? { json, noOpen } : { json, noOpen, error: true };
}

interface ParsedFirefliesConnectArgs {
  json: boolean;
  noOpen: boolean;
  error?: true;
}

function parseFirefliesConnectArgs(args: string[]): ParsedFirefliesConnectArgs {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const noOpenCount = args.filter((arg) => arg === "--no-open").length;
  const json = jsonCount > 0;
  const noOpen = noOpenCount > 0;
  const valid = args[0] === "fireflies" &&
    jsonCount <= 1 &&
    noOpenCount <= 1 &&
    args.slice(1).every((arg) => arg === "--json" || arg === "--no-open");
  return valid ? { json, noOpen } : { json, noOpen, error: true };
}

interface ParsedCredentialConnectArgs {
  json: boolean;
  source: CredentialSource;
  error?: true;
}

function parseCredentialConnectArgs(provider: "linear" | "claude-code", args: string[]): ParsedCredentialConnectArgs {
  const json = args.includes("--json");
  if (args[0] !== provider) return { json, source: { kind: "tty" }, error: true };
  try {
    const { source, remaining } = parseCredentialSourceOptions(args.slice(1));
    const jsonCount = remaining.filter((arg) => arg === "--json").length;
    const valid = jsonCount <= 1 && remaining.every((arg) => arg === "--json");
    return valid ? { json, source } : { json, source, error: true };
  } catch (error) {
    if (error instanceof CredentialInputError) return { json, source: { kind: "tty" }, error: true };
    throw error;
  }
}

interface ParsedSlackConnectArgs {
  json: boolean;
  noOpen: boolean;
  source: CredentialSource;
  error?: true;
}

function parseSlackConnectArgs(args: string[]): ParsedSlackConnectArgs {
  const json = args.includes("--json");
  const noOpen = args.includes("--no-open");
  if (args[0] !== "slack") return { json, noOpen, source: { kind: "tty" }, error: true };
  try {
    const { source, remaining } = parseCredentialSourceOptions(args.slice(1));
    const jsonCount = remaining.filter((arg) => arg === "--json").length;
    const noOpenCount = remaining.filter((arg) => arg === "--no-open").length;
    const valid = jsonCount <= 1 &&
      noOpenCount <= 1 &&
      remaining.every((arg) => arg === "--json" || arg === "--no-open");
    return valid ? { json, noOpen, source } : { json, noOpen, source, error: true };
  } catch (error) {
    if (error instanceof CredentialInputError) return { json, noOpen, source: { kind: "tty" }, error: true };
    throw error;
  }
}

interface ParsedGranolaConnectArgs {
  json: boolean;
  source: CredentialSource;
  workspaceKey: boolean;
  error?: true;
}

function parseGranolaConnectArgs(args: string[]): ParsedGranolaConnectArgs {
  const json = args.includes("--json");
  const workspaceKey = args.includes("--workspace-key");
  if (args[0] !== "granola") return { json, source: { kind: "tty" }, workspaceKey, error: true };
  try {
    const { source, remaining } = parseCredentialSourceOptions(args.slice(1));
    const jsonCount = remaining.filter((arg) => arg === "--json").length;
    const workspaceKeyCount = remaining.filter((arg) => arg === "--workspace-key").length;
    const valid = jsonCount <= 1 &&
      workspaceKeyCount <= 1 &&
      remaining.every((arg) => arg === "--json" || arg === "--workspace-key");
    return valid ? { json, source, workspaceKey } : { json, source, workspaceKey, error: true };
  } catch (error) {
    if (error instanceof CredentialInputError) return { json, source: { kind: "tty" }, workspaceKey, error: true };
    throw error;
  }
}

interface ToolIntegration {
  provider: string;
  label: string;
  status: "connected" | "pending" | "needs_reconnect" | "not_connected";
  connectedByYou: boolean;
  ingests: string;
  triggers: Array<{ event: string; label: string }>;
  abilities: string[];
  connect: { cli: string; mcp: string };
  actions?: Array<{ verb: string }>;
  channels?: Array<{ id: string; name: string }>;
  channelsError?: string;
  available?: { channels: Array<{ id: string; name: string; memberCount: number; joined: boolean }>; nextCursor: string | null };
  availableError?: string;
}

interface ListFlags {
  available: boolean;
  query?: string;
  limit?: number;
  cursor?: string;
}

const STATUS_TEXT: Record<ToolIntegration["status"], string> = {
  connected: "connected",
  pending: "connected, waiting for its first event",
  needs_reconnect: "needs reconnect",
  not_connected: "not connected",
};

function readToolIntegrations(output: unknown): ToolIntegration[] | null {
  const list = (output as { connections?: unknown } | null)?.connections;
  return Array.isArray(list) ? (list as ToolIntegration[]) : null;
}

function renderAvailable(item: ToolIntegration, flags: ListFlags): string[] {
  if (item.availableError) return [`  every public channel: ${item.availableError}`];
  if (!item.available) return [];
  const { channels, nextCursor } = item.available;
  const lines = [`  every public channel, biggest first${flags.query ? ` (matching "${flags.query}")` : ""}:`];
  if (channels.length === 0) lines.push("    none");
  const width = Math.max(0, ...channels.map((channel) => channel.name.length));
  for (const channel of channels) {
    lines.push(`    #${channel.name.padEnd(width)}  ${channel.id}  ${String(channel.memberCount).padStart(5)} members  ${channel.joined ? "in" : "not in"}`);
  }
  if (nextCursor) {
    const next = ["draft connections list", `--provider ${item.provider}`, "--available", flags.query ? `--query '${flags.query}'` : null, flags.limit ? `--limit ${flags.limit}` : null, `--cursor '${nextCursor}'`].filter(Boolean).join(" ");
    lines.push(`    More: ${next}`);
  }
  lines.push(`    Join one: draft connections join --provider ${item.provider} --channel '#name'`);
  return lines;
}

function renderIntegrations(items: ToolIntegration[], flags: ListFlags = { available: false }): string {
  return items.map((item) => {
    const lines = [`${item.label}: ${STATUS_TEXT[item.status]}${item.connectedByYou ? " (you)" : ""}`];
    lines.push(`  brings in: ${item.ingests}`);
    if (item.triggers.length > 0) lines.push(`  unlocks triggers: ${item.triggers.map((trigger) => trigger.label).join(", ")}`);
    if (item.abilities.length > 0) lines.push(`  lets routines: ${item.abilities.join("; ")}`);
    if (item.channels) lines.push(`  channels the bot has joined: ${item.channels.length ? item.channels.map((channel) => `#${channel.name}`).join(", ") : "none yet"}`);
    if (item.channelsError) lines.push(`  channels: ${item.channelsError}`);
    lines.push(...renderAvailable(item, flags));
    const verbs = (item.actions ?? []).map((action) => action.verb).filter((verb) => verb !== "connect");
    if (verbs.length > 0) lines.push(`  you can: ${verbs.map((verb) => `draft connections ${verb} --provider ${item.provider}`).join(", ")}`);
    if (item.status === "needs_reconnect" || item.status === "not_connected") lines.push(`  connect: ${item.connect.cli}`);
    return lines.join("\n");
  }).join("\n\n");
}

function toIntegrationErrorCode(code: string): IntegrationErrorCode {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_ERROR_REGISTRY, code) ? (code as IntegrationErrorCode) : "request_failed";
}

async function runIntegrationsList(args: string[]): Promise<number> {
  const command = "draft connections list";
  const json = args.includes("--json");
  const provider = takeProviderFlag(args);
  const query = takeValueFlag(provider.rest, "--query");
  const limit = takeValueFlag(query.rest, "--limit");
  const cursor = takeValueFlag(limit.rest, "--cursor");
  const available = cursor.rest.includes("--available");
  const parsed = parseListArgs(cursor.rest.filter((arg) => arg !== "--available"));
  const problem = provider.error ?? query.error ?? limit.error ?? cursor.error;
  if (parsed.error || problem) return usageError(command, json, problem ?? "unexpected argument");
  if (cursor.rest.filter((arg) => arg === "--available").length > 1) return usageError(command, json, "--available was given twice");
  if (!available && (query.value !== undefined || limit.value !== undefined || cursor.value !== undefined)) return usageError(command, json, "--query, --limit and --cursor go with --available");
  if (available && !provider.provider) return usageError(command, json, "--available needs --provider slack");
  const limitNumber = limit.value === undefined ? undefined : Number(limit.value);
  if (limitNumber !== undefined && (!Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > 100)) return usageError(command, json, "--limit must be a whole number from 1 to 100");
  const flags: ListFlags = { available, query: query.value, limit: limitNumber, cursor: cursor.value };
  const output = createIntegrationOutput({ json: parsed.json });

  const result = await callPersonTool("connections.list", {
    ...(provider.provider ? { provider: toBackendProvider(provider.provider) } : {}),
    ...(available ? { available: true } : {}),
    ...(flags.query !== undefined ? { query: flags.query } : {}),
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    ...(flags.cursor !== undefined ? { cursor: flags.cursor } : {}),
  });
  if (!result.ok) {
    return output.error(toIntegrationErrorCode(result.refusal ?? result.code));
  }

  const items = readToolIntegrations(result.output);
  if (!items) {
    return output.error("malformed_response");
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    return 0;
  }
  process.stdout.write(`${renderIntegrations(items, flags)}\n`);
  return 0;
}


function hasExplicitCredentialSource(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("--credential-"));
}

async function runIntegrationsConnect(rawArgs: string[]): Promise<number> {
  const taken = takeProviderFlag(rawArgs, "connect");
  if (taken.error || !taken.provider) {
    if (taken.error?.includes("connect together")) process.stderr.write(`${taken.error}\n`);
    return createIntegrationOutput({ json: rawArgs.includes("--json") }).error("invalid_connect_usage");
  }
  // The provider goes first so each provider's own parser below sees the grammar it was written for.
  const args = [taken.provider, ...taken.rest];
  // Google sign-in always happens in the browser, so agents and people share one flow.
  if (args[0] === "google") {
    const parsed = parseGithubConnectArgs(args, "google");
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runGoogleConnect({ noOpen: parsed.noOpen }, output);
  }
  // Agents and scripts get a link to open. An explicit credential flag keeps the
  // existing key-reading flow, so a human who passes one still gets it.
  const agentMode = !hasExplicitCredentialSource(args) && (args.includes("--json") || !isInteractiveTerminal());
  if (agentMode) {
    const parsed = parseAgentConnectArgs(args);
    if (!parsed) return createIntegrationOutput({ json: args.includes("--json") }).error("invalid_usage");
    return runAgentConnect(parsed);
  }
  if (args[0] === "linear") {
    const parsed = parseCredentialConnectArgs("linear", args);
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runLinearConnect({ source: parsed.source }, output);
  }
  if (args[0] === "claude-code") {
    const parsed = parseCredentialConnectArgs("claude-code", args);
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runClaudeCodeConnect({ source: parsed.source }, output);
  }
  if (args[0] === "slack") {
    const parsed = parseSlackConnectArgs(args);
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runSlackConnect({ noOpen: parsed.noOpen, source: parsed.source }, output);
  }
  if (args[0] === "fireflies") {
    const parsed = parseFirefliesConnectArgs(args);
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runFirefliesConnect({ noOpen: parsed.noOpen }, output);
  }
  if (args[0] === "granola") {
    const parsed = parseGranolaConnectArgs(args);
    const output = createIntegrationOutput({ json: parsed.json });
    if (parsed.error) return output.error("invalid_usage");
    return runGranolaConnect(
      { source: parsed.source, accountKind: parsed.workspaceKey ? "workspace" : "personal" },
      output,
    );
  }
  const parsed = parseGithubConnectArgs(args);
  const output = createIntegrationOutput({ json: parsed.json });
  if (parsed.error) return output.error("invalid_usage");
  return runGithubConnect({ noOpen: parsed.noOpen }, output);
}

export async function runIntegrations(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    process.stdout.write(integrationsGroupHelp());
    return 0;
  }
  if (subcommand && (args.includes("--help") || args.includes("-h"))) {
    const { provider } = takeProviderFlag(rest.filter((arg) => arg !== "--help" && arg !== "-h"));
    process.stdout.write(integrationsSubcommandHelp(subcommand, provider) ?? integrationsGroupHelp());
    return 0;
  }
  if (subcommand === "list") return runIntegrationsList(rest);
  if (subcommand === "disconnect") return runConnectionsDisconnect(rest);
  if (subcommand === "connect") return runIntegrationsConnect(rest);
  if (subcommand === "join") return runConnectionsJoin(rest);
  if (subcommand === "leave") return runConnectionsLeave(rest);
  if (subcommand === "read") return runConnectionsRead(rest);
  if (subcommand === "search") return runConnectionsSearch(rest);
  if (subcommand === "post") return runConnectionsPost(rest);
  if (subcommand === "drive") return runDriveFolders(rest);

  const json = args.includes("--json");
  return createIntegrationOutput({ json }).error("invalid_usage");
}
