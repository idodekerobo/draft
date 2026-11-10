// commands/tools.ts — draft tools list | call <name>
//
// The run-scoped tool surface for an agent that has a shell but no MCP. A run proves itself
// with the token Draft gave it (DRAFT_RUN_ID + DRAFT_RUN_TOKEN), not with a person's login.

import { decodeToolEnvelope } from "draft-core/tool-envelope";
import { readFileSync } from "fs";
import { getCliRuntimeConfig } from "../runtime-config.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

interface RunCredentials {
  runId: string;
  token: string;
}

function readRunCredentials(env: NodeJS.ProcessEnv = process.env): RunCredentials | null {
  const runId = env.DRAFT_RUN_ID?.trim();
  const token = env.DRAFT_RUN_TOKEN?.trim();
  return runId && token ? { runId, token } : null;
}

function fail(json: boolean, code: string, message: string, exitCode: number): number {
  if (json) printJsonLine(errorPayload(code, message));
  else console.error(red(`tools: ${message}`));
  return exitCode;
}

function parseArgsOption(args: string[]): { remaining: string[]; json?: string; file?: string; error?: string } {
  const remaining: string[] = [];
  let json: string | undefined;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--args" || arg === "--args-file") {
      const value = args[++i];
      if (value === undefined) return { remaining, error: `${arg} requires a value` };
      if (arg === "--args") json = value;
      else file = value;
    } else if (arg.startsWith("--args=")) json = arg.slice("--args=".length);
    else if (arg.startsWith("--args-file=")) file = arg.slice("--args-file=".length);
    else remaining.push(arg);
  }
  return { remaining, json, file };
}

export async function runTools(args: string[]): Promise<number> {
  const wantsJson = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const sub = rest[0];

  if (!sub || (sub !== "list" && sub !== "call")) {
    console.error("Usage: draft tools list [--json]\n       draft tools call <name> [--args '<json>' | --args-file <path>]");
    return EXIT_USAGE_ERROR;
  }

  const credentials = readRunCredentials();
  if (!credentials) {
    return fail(wantsJson, "not_in_a_run", "This command works inside an agent run. DRAFT_RUN_ID and DRAFT_RUN_TOKEN are not set.", EXIT_USAGE_ERROR);
  }
  const base = `${getCliRuntimeConfig().apiBaseUrl}/runs/${encodeURIComponent(credentials.runId)}/tools`;
  const headers = { Authorization: `Bearer ${credentials.token}` };

  try {
    if (sub === "list") {
      const response = await fetch(base, { headers });
      if (response.status === 401) return fail(wantsJson, "unauthorized", "The run token was refused. The run may have finished.", EXIT_OPERATIONAL_ERROR);
      if (!response.ok) return fail(wantsJson, "request_failed", `The tools API answered ${response.status}.`, EXIT_OPERATIONAL_ERROR);
      const body = (await response.json()) as { tools: Array<{ name: string; access: string; description: string; inputSchema: unknown }> };
      if (wantsJson) {
        printJsonLine({ status: "ok", tools: body.tools });
        return EXIT_SUCCESS;
      }
      if (body.tools.length === 0) console.log("No tools are available to this run.");
      for (const tool of body.tools) {
        console.log(`${bold(tool.name)} ${dim(`(${tool.access})`)}`);
        console.log(`  ${tool.description}`);
        console.log(`  ${dim(`input: ${JSON.stringify(tool.inputSchema)}`)}`);
      }
      return EXIT_SUCCESS;
    }

    const parsed = parseArgsOption(rest.slice(1));
    if (parsed.error) return fail(wantsJson, "usage", parsed.error, EXIT_USAGE_ERROR);
    const name = parsed.remaining[0];
    if (!name) return fail(wantsJson, "usage", "Give the tool name: draft tools call <name>", EXIT_USAGE_ERROR);
    let body = "{}";
    if (parsed.file) {
      try {
        body = readFileSync(parsed.file, "utf8");
      } catch {
        return fail(wantsJson, "usage", `Cannot read ${parsed.file}`, EXIT_USAGE_ERROR);
      }
    } else if (parsed.json !== undefined) body = parsed.json;

    const response = await fetch(`${base}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });
    if (response.status === 401) return fail(wantsJson, "unauthorized", "The run token was refused. The run may have finished.", EXIT_OPERATIONAL_ERROR);
    const result = await response.json().catch(() => null);
    if (!result) return fail(wantsJson, "request_failed", `The tools API answered ${response.status} with no result.`, EXIT_OPERATIONAL_ERROR);
    if (wantsJson) printJsonLine(result);
    else console.log(JSON.stringify(result, null, 2));
    // A conflict is an answer the agent acts on, so it is not a failure of the command. A refusal, a denial and an error are.
    return decodeToolEnvelope(result).ok ? EXIT_SUCCESS : EXIT_OPERATIONAL_ERROR;
  } catch (error) {
    return fail(wantsJson, "request_failed", `Could not reach Draft: ${error instanceof Error ? error.message : String(error)}`, EXIT_OPERATIONAL_ERROR);
  }
}
