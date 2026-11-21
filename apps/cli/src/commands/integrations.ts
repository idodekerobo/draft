import { callPersonTool } from "../cloud-client.ts";
import { runConnectChannels, runConnectionsDisconnect, runConnectionsPost, runConnectionsRead, takeProviderFlag, takeValueFlag } from "../integrations/tool-commands.ts";
import { createIntegrationOutput, INTEGRATION_ERROR_REGISTRY, type IntegrationErrorCode } from "../integrations/safe-output.ts";
import { isInteractiveTerminal, parseAgentConnectArgs, runAgentConnect, toBackendProvider } from "../integrations/agent.ts";
import { integrationsGroupHelp, integrationsSubcommandHelp } from "../integrations/help.ts";
import { runGithubConnect } from "../integrations/providers/github.ts";
import { runLinearConnect } from "../integrations/providers/linear.ts";
import { runClaudeCodeConnect } from "../integrations/providers/claude-code.ts";
import { runSlackConnect } from "../integrations/providers/slack.ts";
import { runFirefliesConnect } from "../integrations/providers/fireflies.ts";
import { runGranolaConnect } from "../integrations/providers/granola.ts";
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

function parseGithubConnectArgs(args: string[]): ParsedGithubConnectArgs {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const noOpenCount = args.filter((arg) => arg === "--no-open").length;
  const json = jsonCount > 0;
  const noOpen = noOpenCount > 0;
  const valid = args[0] === "github" &&
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

function renderIntegrations(items: ToolIntegration[]): string {
  return items.map((item) => {
    const lines = [`${item.label}: ${STATUS_TEXT[item.status]}${item.connectedByYou ? " (you)" : ""}`];
    lines.push(`  brings in: ${item.ingests}`);
    if (item.triggers.length > 0) lines.push(`  unlocks triggers: ${item.triggers.map((trigger) => trigger.label).join(", ")}`);
    if (item.abilities.length > 0) lines.push(`  lets routines: ${item.abilities.join("; ")}`);
    if (item.channels) lines.push(`  channels the bot has joined: ${item.channels.length ? item.channels.map((channel) => `#${channel.name}`).join(", ") : "none yet"}`);
    if (item.channelsError) lines.push(`  channels: ${item.channelsError}`);
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
  const taken = takeProviderFlag(args);
  const parsed = parseListArgs(taken.rest);
  const output = createIntegrationOutput({ json: parsed.json });
  if (parsed.error || taken.error) {
    return output.error("invalid_usage");
  }

  const result = await callPersonTool("connections.list", taken.provider ? { provider: toBackendProvider(taken.provider) } : {});
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
  process.stdout.write(`${renderIntegrations(items)}\n`);
  return 0;
}


function hasExplicitCredentialSource(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("--credential-"));
}

async function runIntegrationsConnect(rawArgs: string[]): Promise<number> {
  const taken = takeProviderFlag(rawArgs);
  const channels = takeValueFlag(taken.rest, "--channels");
  if (taken.error || channels.error || !taken.provider) {
    return createIntegrationOutput({ json: rawArgs.includes("--json") }).error("invalid_connect_usage");
  }
  if (channels.value !== undefined) {
    const json = channels.rest.includes("--json");
    if (channels.rest.some((arg) => arg !== "--json")) return createIntegrationOutput({ json }).error("invalid_usage");
    return runConnectChannels(taken.provider, channels.value, json);
  }
  // The provider goes first so each provider's own parser below sees the grammar it was written for.
  const args = [taken.provider, ...taken.rest];
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
    process.stdout.write(integrationsSubcommandHelp(subcommand) ?? integrationsGroupHelp());
    return 0;
  }
  if (subcommand === "list") return runIntegrationsList(rest);
  if (subcommand === "disconnect") return runConnectionsDisconnect(rest);
  if (subcommand === "connect") return runIntegrationsConnect(rest);
  if (subcommand === "read") return runConnectionsRead(rest);
  if (subcommand === "post") return runConnectionsPost(rest);

  const json = args.includes("--json");
  return createIntegrationOutput({ json }).error("invalid_usage");
}
