import { normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import {
  disconnectIntegration,
  listConnections,
} from "../cloud-client.ts";
import {
  BACKEND_PROVIDER_BY_CLI,
  isDisconnectProvider,
  isNetworkDisconnectProvider,
  type DisconnectProvider,
} from "../integrations/types.ts";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runGithubConnect } from "../integrations/providers/github.ts";
import { runLinearConnect } from "../integrations/providers/linear.ts";
import { runClaudeCodeConnect } from "../integrations/providers/claude-code.ts";
import { CredentialInputError, parseCredentialSourceOptions, type CredentialSource } from "../integrations/credentials.ts";

interface ParsedListArgs {
  json: boolean;
  error?: true;
}

interface ParsedDisconnectArgs {
  json: boolean;
  provider?: DisconnectProvider;
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

function parseDisconnectArgs(args: string[]): ParsedDisconnectArgs {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const json = jsonCount > 0;
  if (jsonCount > 1) return { json, error: true };
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      continue;
    }
    if (arg.startsWith("-")) return { json, error: true };
    positionals.push(arg);
  }
  if (positionals.length !== 1 || !isDisconnectProvider(positionals[0]!)) {
    return { json, error: true };
  }
  return { json, provider: positionals[0] };
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

async function runIntegrationsList(args: string[]): Promise<number> {
  const parsed = parseListArgs(args);
  const output = createIntegrationOutput({ json: parsed.json });
  if (parsed.error) {
    return output.error("invalid_usage");
  }

  const result = await listConnections();
  if (!result.ok) {
    return output.error(result.code);
  }

  const connections = normalizeHostedConnections(result.value.connections);
  return output.event({ status: "ok", connections });
}

async function runIntegrationsDisconnect(args: string[]): Promise<number> {
  const parsed = parseDisconnectArgs(args);
  const output = createIntegrationOutput({ json: parsed.json });
  if (parsed.error || !parsed.provider) {
    return output.error("invalid_usage");
  }

  if (!isNetworkDisconnectProvider(parsed.provider)) {
    return output.error("not_supported");
  }

  const result = await disconnectIntegration(BACKEND_PROVIDER_BY_CLI[parsed.provider]);
  if (!result.ok) {
    return output.error(result.code);
  }

  return output.event({ status: "disconnected", provider: parsed.provider });
}

async function runIntegrationsConnect(args: string[]): Promise<number> {
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
  const parsed = parseGithubConnectArgs(args);
  const output = createIntegrationOutput({ json: parsed.json });
  if (parsed.error) return output.error("invalid_usage");
  return runGithubConnect({ noOpen: parsed.noOpen }, output);
}

export async function runIntegrations(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return runIntegrationsList(rest);
  if (subcommand === "disconnect") return runIntegrationsDisconnect(rest);
  if (subcommand === "connect") return runIntegrationsConnect(rest);

  const json = args.includes("--json");
  return createIntegrationOutput({ json }).error("invalid_usage");
}
