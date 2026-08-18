// commands/context.ts — draft context list|read

import { discoverDimensions, fetchWorkspaceContext, type WorkspaceContextSnapshot } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { red } from "../utils/output.ts";

const SELECTOR_PATTERN = /^[a-z0-9-]+$/;

function fetchErrorPayload(code: string) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  return errorPayload(code, "Could not fetch workspace context right now. Retry shortly.");
}

function printFetchError(command: string, code: string, json: boolean): void {
  const payload = fetchErrorPayload(code);
  if (json) { printJsonLine(payload); return; }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
}

export async function runContextList(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.find((a) => a !== "--json");
  if (unknown) {
    if (json) printJsonLine(errorPayload("invalid_usage", `unexpected argument: ${unknown}`));
    else console.error(red(`draft context list: unexpected argument: ${unknown}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await fetchWorkspaceContext();
  if (!result.ok) {
    printFetchError("draft context list", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  const dimensions = discoverDimensions(result.snapshot.documents);
  if (json) {
    printJsonLine({ dimensions: dimensions.map((d) => ({ name: d.name, path: d.path })) });
    return EXIT_SUCCESS;
  }

  if (dimensions.length === 0) {
    console.log("No dimensions found.");
    return EXIT_SUCCESS;
  }
  for (const d of dimensions) console.log(d.name);
  return EXIT_SUCCESS;
}

interface ParsedReadArgs {
  dimensions?: string[];
  all?: boolean;
  json: boolean;
  error?: string;
}

function parseReadArgs(args: string[]): ParsedReadArgs {
  const requested: string[] = [];
  let all = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--all") { all = true; continue; }
    if (arg === "--dimension") {
      const value = args[++i];
      if (value === undefined) return { json, error: "--dimension requires a value" };
      requested.push(value);
      continue;
    }
    if (arg.startsWith("--dimension=")) { requested.push(arg.slice("--dimension=".length)); continue; }
    if (arg.startsWith("--")) return { json, error: `unknown flag: ${arg}` };
    return { json, error: `unexpected positional argument: ${arg}` };
  }

  if (all && requested.length > 0) return { json, error: "--dimension and --all are mutually exclusive" };
  if (!all && requested.length === 0) return { json, error: "missing selector — pass one or more --dimension <name>, or --all. See `draft context list`." };

  if (!all) {
    for (const name of requested) {
      if (!SELECTOR_PATTERN.test(name)) return { json, error: `invalid --dimension value: ${name}` };
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (!seen.has(name)) { seen.add(name); deduped.push(name); }
  }

  return all ? { all: true, json } : { dimensions: deduped, json };
}

function renderHuman(snapshot: WorkspaceContextSnapshot, selected: { name: string; path: string }[]): void {
  if (selected.length === 1) {
    console.log(snapshot.documents[selected[0].path]?.content ?? "");
    return;
  }
  const parts = selected.map((d) => `===== ${d.path} =====\n${snapshot.documents[d.path]?.content ?? ""}`);
  console.log(parts.join("\n"));
}

export async function runContextRead(args: string[]): Promise<number> {
  const parsed = parseReadArgs(args);
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft context read: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await fetchWorkspaceContext();
  if (!result.ok) {
    printFetchError("draft context read", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  const discovered = discoverDimensions(result.snapshot.documents);
  const byName = new Map(discovered.map((d) => [d.name, d]));

  let selected: { name: string; path: string }[];
  if (parsed.all) {
    selected = discovered;
    if (selected.length === 0) {
      if (parsed.json) {
        printJsonLine({ versionId: result.snapshot.versionId, versionNumber: result.snapshot.versionNumber, contentHash: result.snapshot.contentHash, creationReason: result.snapshot.creationReason, createdAt: result.snapshot.createdAt, documents: [] });
      } else console.log("No dimensions found.");
      return EXIT_SUCCESS;
    }
  } else {
    const requested = parsed.dimensions ?? [];
    const missing = requested.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      const available = discovered.map((d) => d.name);
      if (parsed.json) {
        printJsonLine({ status: "error", code: "unknown_dimension", message: `Unknown dimension(s): ${missing.join(", ")}`, missing, available });
      } else {
        console.error(red(`draft context read: unknown dimension(s): ${missing.join(", ")}`));
        console.error(available.length > 0 ? `Available: ${available.join(", ")}` : "Available: (none)");
      }
      return EXIT_OPERATIONAL_ERROR;
    }
    selected = requested.map((name) => byName.get(name)!);
  }

  if (parsed.json) {
    printJsonLine({
      versionId: result.snapshot.versionId,
      versionNumber: result.snapshot.versionNumber,
      contentHash: result.snapshot.contentHash,
      creationReason: result.snapshot.creationReason,
      createdAt: result.snapshot.createdAt,
      documents: selected.map((d) => ({ name: d.name, path: d.path, content: result.snapshot.documents[d.path]?.content ?? "", sha256: result.snapshot.documents[d.path]?.sha256 })),
    });
    return EXIT_SUCCESS;
  }

  renderHuman(result.snapshot, selected);
  return EXIT_SUCCESS;
}

export async function runContext(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list": return runContextList(rest);
    case "read": return runContextRead(rest);
    default:
      console.error(red(`draft context: unknown subcommand${sub ? ` "${sub}"` : ""}. Use list or read.`));
      return EXIT_USAGE_ERROR;
  }
}
