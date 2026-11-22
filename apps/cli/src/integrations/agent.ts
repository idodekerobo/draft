// integrations/agent.ts — connect for agents and scripts. One tool call returns a link the person opens.
// The key never passes through the CLI, so this path never reads stdin.
import { callPersonTool, type ToolCallResult } from "../cloud-client.ts";
import { SCHEMA_VERSION, EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, errorPayload } from "../utils/json-output.ts";
import { red } from "../utils/output.ts";
import { HOSTED_CONNECTION_PROVIDERS, toBackendProviderName } from "draft-core/integrations/hosted-connections";
import { PROVIDER_LABELS } from "./types.ts";

export const CONNECT_CLI_PROVIDERS = HOSTED_CONNECTION_PROVIDERS;
export type ConnectCliProvider = (typeof CONNECT_CLI_PROVIDERS)[number];

export const toBackendProvider = toBackendProviderName;

const POLL_INTERVAL_MS = 3_000;

export interface ParsedAgentConnectArgs {
  provider: ConnectCliProvider;
  json: boolean;
  wait: boolean;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Accepts `<provider> [--json] [--wait]`, each flag at most once. Returns null for anything else. */
export function parseAgentConnectArgs(args: readonly string[]): ParsedAgentConnectArgs | null {
  const [provider, ...flags] = args;
  if (!provider || !(CONNECT_CLI_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (flags.some((flag) => flag !== "--json" && flag !== "--wait")) return null;
  if (new Set(flags).size !== flags.length) return null;
  return { provider: provider as ConnectCliProvider, json: flags.includes("--json"), wait: flags.includes("--wait") };
}

export interface AgentConnectDeps {
  callTool(name: string, input: unknown): Promise<ToolCallResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const defaultAgentConnectDeps: AgentConnectDeps = {
  callTool: callPersonTool,
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
};

type ConnectOutput =
  | { status: "connected"; provider: string; message?: string }
  | { status: "pending"; provider: string; message?: string }
  | { status: "action_required"; url: string; expiresAt: string; [key: string]: unknown };

function readConnectOutput(output: unknown): ConnectOutput | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (record.status === "connected" && typeof record.provider === "string") {
    return { status: "connected", provider: record.provider, ...(typeof record.message === "string" ? { message: record.message } : {}) };
  }
  if (record.status === "pending" && typeof record.provider === "string") {
    return { status: "pending", provider: record.provider, ...(typeof record.message === "string" ? { message: record.message } : {}) };
  }
  if (
    record.status === "action_required" &&
    typeof record.url === "string" &&
    typeof record.expiresAt === "string" &&
    !Number.isNaN(Date.parse(record.expiresAt))
  ) {
    return { ...record, status: "action_required", url: record.url, expiresAt: record.expiresAt };
  }
  return null;
}

function isConnectedIn(output: unknown, backendProvider: string): boolean {
  const list = (output as { connections?: unknown } | null)?.connections;
  return Array.isArray(list) && list.some((item) =>
    (item as { provider?: unknown; status?: unknown }).provider === backendProvider &&
    (item as { status?: unknown }).status === "connected"
  );
}

function emitJson(deps: AgentConnectDeps, value: object): void {
  deps.stdout(`${JSON.stringify({ schema_version: SCHEMA_VERSION, ...value })}\n`);
}

function fail(json: boolean, deps: AgentConnectDeps, code: string, message: string): number {
  if (json) emitJson(deps, errorPayload(code, message));
  else deps.stderr(`${red(`draft connections connect: ${message}`)}\n`);
  return EXIT_OPERATIONAL_ERROR;
}

function succeed(json: boolean, deps: AgentConnectDeps, provider: ConnectCliProvider, backendProvider: string, message?: string): number {
  if (json) emitJson(deps, { status: "connected", provider: backendProvider, ...(message ? { message } : {}) });
  else deps.stdout(message ? `${message}\n` : `Connected: ${PROVIDER_LABELS[provider]}.\n`);
  return EXIT_SUCCESS;
}

export async function runAgentConnect(
  options: ParsedAgentConnectArgs,
  deps: AgentConnectDeps = defaultAgentConnectDeps,
): Promise<number> {
  const backendProvider = toBackendProvider(options.provider);
  const label = PROVIDER_LABELS[options.provider];

  const started = await deps.callTool("connections.connect", { provider: backendProvider });
  if (!started.ok) {
    return fail(options.json, deps, started.refusal ?? started.code, started.message ?? "Could not start the connection. Retry shortly.");
  }
  const link = readConnectOutput(started.output);
  if (!link) {
    return fail(options.json, deps, "malformed_response", "The Draft backend returned an invalid response. Retry shortly.");
  }
  if (link.status === "connected") return succeed(options.json, deps, options.provider, link.provider, link.message);
  if (link.status === "pending") {
    if (options.json) emitJson(deps, link);
    else deps.stdout(`${link.message ?? `${label} is saved and waiting for its first event.`}\n`);
    return EXIT_SUCCESS;
  }

  if (options.json) emitJson(deps, link);
  else deps.stdout(`Open this link to connect ${label}: ${link.url} (expires ${link.expiresAt})\n`);
  if (!options.wait) return EXIT_SUCCESS;

  const deadline = Date.parse(link.expiresAt);
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const listed = await deps.callTool("connections.list", {});
    if (!listed.ok) {
      return fail(options.json, deps, listed.refusal ?? listed.code, listed.message ?? "Could not check the connection. Retry shortly.");
    }
    if (isConnectedIn(listed.output, backendProvider)) return succeed(options.json, deps, options.provider, backendProvider);
  }
  return fail(options.json, deps, "expired", "The link expired before it was used. Run the connect command again for a new link.");
}
