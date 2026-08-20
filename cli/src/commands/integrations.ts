import { normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import {
  disconnectIntegration,
  listConnections,
  type FetchErrorCode,
} from "../cloud-client.ts";
import {
  BACKEND_PROVIDER_BY_CLI,
  DISCONNECT_PROVIDERS,
  PROVIDER_LABELS,
  isDisconnectProvider,
  type DisconnectProvider,
} from "../integrations/types.ts";
import {
  EXIT_OPERATIONAL_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  errorPayload,
  printJsonLine,
  type ErrorPayload,
} from "../utils/json-output.ts";
import { red } from "../utils/output.ts";

interface ParsedListArgs {
  json: boolean;
  error?: true;
}

interface ParsedDisconnectArgs {
  json: boolean;
  provider?: DisconnectProvider;
  error?: true;
}

const ERROR_MESSAGES: Partial<Record<FetchErrorCode, { message: string; action?: string }>> = {
  not_authenticated: { message: "Not signed in.", action: "draft auth login" },
  auth_busy: { message: "Authentication is busy. Retry shortly." },
  session_refresh_transient: { message: "Could not refresh the current session. Retry shortly." },
  whoami_failed: { message: "Could not verify the current workspace. Retry shortly." },
  no_workspace: { message: "No workspace yet — finish onboarding in the Draft app." },
  malformed_response: { message: "The Draft backend returned an invalid response. Retry shortly." },
  not_found: { message: "That integration is already disconnected." },
  not_supported: { message: "That integration operation is not supported." },
  connection_update_conflict: { message: "The integration changed concurrently. Retry shortly." },
};

function fetchError(code: FetchErrorCode): ErrorPayload {
  const reviewed = ERROR_MESSAGES[code];
  return reviewed
    ? errorPayload(code, reviewed.message, reviewed.action)
    : errorPayload("request_failed", "Could not update hosted integrations right now. Retry shortly.");
}

function printFetchError(command: string, code: FetchErrorCode, json: boolean): void {
  const payload = fetchError(code);
  if (json) {
    printJsonLine(payload);
    return;
  }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
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

function printUsageError(command: string, message: string, json: boolean): number {
  if (json) printJsonLine(errorPayload("invalid_usage", message));
  else console.error(red(`${command}: ${message}`));
  return EXIT_USAGE_ERROR;
}

async function runIntegrationsList(args: string[]): Promise<number> {
  const parsed = parseListArgs(args);
  if (parsed.error) {
    return printUsageError(
      "draft integrations list",
      "Invalid arguments. Usage: draft integrations list [--json]",
      parsed.json,
    );
  }

  const result = await listConnections();
  if (!result.ok) {
    printFetchError("draft integrations list", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  const connections = normalizeHostedConnections(result.value.connections);
  if (parsed.json) {
    printJsonLine({ status: "ok", connections });
    return EXIT_SUCCESS;
  }
  for (const connection of connections) {
    console.log(`${PROVIDER_LABELS[connection.provider]}: ${connection.status}`);
  }
  return EXIT_SUCCESS;
}

async function runIntegrationsDisconnect(args: string[]): Promise<number> {
  const parsed = parseDisconnectArgs(args);
  if (parsed.error || !parsed.provider) {
    return printUsageError(
      "draft integrations disconnect",
      `Invalid provider or arguments. Usage: draft integrations disconnect <${DISCONNECT_PROVIDERS.join("|")}> [--json]`,
      parsed.json,
    );
  }

  const result = await disconnectIntegration(BACKEND_PROVIDER_BY_CLI[parsed.provider]);
  if (!result.ok) {
    printFetchError("draft integrations disconnect", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (parsed.json) {
    printJsonLine({ status: "disconnected", provider: parsed.provider });
  } else {
    console.log(`${PROVIDER_LABELS[parsed.provider]}: disconnected`);
  }
  return EXIT_SUCCESS;
}

export async function runIntegrations(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return runIntegrationsList(rest);
  if (subcommand === "disconnect") return runIntegrationsDisconnect(rest);

  const json = args.includes("--json");
  return printUsageError(
    "draft integrations",
    "Invalid subcommand. Usage: draft integrations <list|disconnect>",
    json,
  );
}
