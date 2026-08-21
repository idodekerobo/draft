import { normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import {
  disconnectIntegration,
  listConnections,
} from "../cloud-client.ts";
import {
  BACKEND_PROVIDER_BY_CLI,
  isDisconnectProvider,
  type DisconnectProvider,
} from "../integrations/types.ts";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runGithubConnect } from "../integrations/providers/github.ts";

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

  const result = await disconnectIntegration(BACKEND_PROVIDER_BY_CLI[parsed.provider]);
  if (!result.ok) {
    return output.error(result.code);
  }

  return output.event({ status: "disconnected", provider: parsed.provider });
}

async function runIntegrationsConnect(args: string[]): Promise<number> {
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
