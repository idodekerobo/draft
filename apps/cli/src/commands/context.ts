// commands/context.ts — draft context list|read|export

import { discoverDimensions, fetchContextExport, fetchWorkspaceContext, runModeErrorMessage, type ContextDocumentChange, type WorkspaceContextSnapshot } from "../cloud-client.ts";
import type { ContextExportError } from "../utils/context-export.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { red } from "../utils/output.ts";

const SELECTOR_PATTERN = /^[a-z0-9-]+$/;

function fetchErrorPayload(code: string) {
  const runMode = runModeErrorMessage(code);
  if (runMode) return errorPayload(code, runMode);
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  if (code === "no_context") return errorPayload(code, "No context yet — Draft has not built your company brain.");
  if (code === "period_not_found") return errorPayload(code, "No document exists for that period yet.");
  if (code === "invalid_period") return errorPayload(code, "Unrecognized --period value. See `draft context read --help`.");
  if (code === "invalid_history") return errorPayload(code, "--history needs --paths: name the documents whose history you want.");
  if (code === "version_not_found") return errorPayload(code, "No context version with that id exists in this workspace.");
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
  period?: string;
  /** Exact document paths. Read on their own, with no dimension. */
  paths?: string[];
  /** With paths: the number of recent changes to show for each. */
  history?: number;
  versionId?: string;
  json: boolean;
  error?: string;
}

const MAX_PATHS = 50;
const MAX_HISTORY = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reads a "--flag value" or "--flag=value" pair starting at args[i], where
// the caller has already confirmed arg matches one of those two forms.
function readValueFlag(args: string[], i: number, flag: string): { value: string; nextIndex: number } | { error: string } {
  const arg = args[i];
  if (arg === `--${flag}`) {
    const value = args[i + 1];
    return value === undefined ? { error: `--${flag} requires a value` } : { value, nextIndex: i + 1 };
  }
  return { value: arg.slice(`--${flag}=`.length), nextIndex: i };
}

function parseReadArgs(args: string[]): ParsedReadArgs {
  const requested: string[] = [];
  let all = false;
  let json = false;
  let period: string | undefined;
  const paths: string[] = [];
  let history: number | undefined;
  let versionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--all") { all = true; continue; }
    if (arg === "--paths" || arg.startsWith("--paths=")) {
      const result = readValueFlag(args, i, "paths");
      if ("error" in result) return { json, error: result.error };
      paths.push(...result.value.split(",").map((path) => path.trim()).filter(Boolean));
      i = result.nextIndex;
      continue;
    }
    if (arg === "--history" || arg.startsWith("--history=")) {
      const result = readValueFlag(args, i, "history");
      if ("error" in result) return { json, error: result.error };
      const count = Number(result.value);
      if (!Number.isInteger(count) || count < 1 || count > MAX_HISTORY) return { json, error: `--history must be a whole number from 1 to ${MAX_HISTORY}` };
      history = count;
      i = result.nextIndex;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=")) {
      const result = readValueFlag(args, i, "version");
      if ("error" in result) return { json, error: result.error };
      if (!UUID_PATTERN.test(result.value)) return { json, error: "--version must be a version id from a history entry" };
      versionId = result.value;
      i = result.nextIndex;
      continue;
    }
    if (arg === "--dimension" || arg.startsWith("--dimension=")) {
      const result = readValueFlag(args, i, "dimension");
      if ("error" in result) return { json, error: result.error };
      requested.push(result.value);
      i = result.nextIndex;
      continue;
    }
    if (arg === "--period" || arg.startsWith("--period=")) {
      const result = readValueFlag(args, i, "period");
      if ("error" in result) return { json, error: result.error };
      period = result.value;
      i = result.nextIndex;
      continue;
    }
    if (arg.startsWith("--")) return { json, error: `unknown flag: ${arg}` };
    return { json, error: `unexpected positional argument: ${arg}` };
  }

  if (paths.length > 0) {
    if (all || requested.length > 0 || period) return { json, error: "--paths cannot be combined with --dimension, --all or --period" };
    if (paths.length > MAX_PATHS) return { json, error: `--paths takes at most ${MAX_PATHS} paths` };
    return { json, paths: [...new Set(paths)], history, versionId };
  }
  if (history !== undefined) return { json, error: "--history requires --paths" };
  if (all && requested.length > 0) return { json, error: "--dimension and --all are mutually exclusive" };
  if (!all && requested.length === 0) return { json, error: "missing selector — pass one or more --dimension <name>, or --all. See `draft context list`." };
  if (period && (all || requested.length !== 1)) {
    return { json, error: "--period requires exactly one --dimension (not --all, not multiple)" };
  }

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

  return all ? { all: true, json, period, versionId } : { dimensions: deduped, json, period, versionId };
}

function snapshotMeta(snapshot: WorkspaceContextSnapshot) {
  return {
    versionId: snapshot.versionId,
    versionNumber: snapshot.versionNumber,
    contentHash: snapshot.contentHash,
    creationReason: snapshot.creationReason,
    createdAt: snapshot.createdAt,
  };
}

function renderHuman(snapshot: WorkspaceContextSnapshot, selected: { name: string; path: string }[]): void {
  if (selected.length === 1) {
    console.log(snapshot.documents[selected[0].path]?.content ?? "");
    return;
  }
  const parts = selected.map((d) => `===== ${d.path} =====\n${snapshot.documents[d.path]?.content ?? ""}`);
  console.log(parts.join("\n"));
}

function renderChange(change: ContextDocumentChange): string {
  const run = change.agentRunId ? ` by run ${change.agentRunId}` : "";
  return `  v${change.versionNumber} ${change.createdAt} ${change.creationReason}${run} (${change.versionId}): ${change.summary}`;
}

/** Reads exact paths, with the history of each when asked, and prints them. */
async function runPathRead(parsed: ParsedReadArgs): Promise<number> {
  const result = await fetchWorkspaceContext({ paths: parsed.paths, history: parsed.history, versionId: parsed.versionId });
  if (!result.ok) {
    printFetchError("draft context read", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }
  const { snapshot } = result;
  if (parsed.json) {
    printJsonLine({
      ...snapshotMeta(snapshot),
      documents: Object.entries(snapshot.documents).map(([path, doc]) => ({ path, content: doc.content, sha256: doc.sha256 })),
      ...(snapshot.history ? { history: snapshot.history } : {}),
      ...(snapshot.missing?.length ? { missing: snapshot.missing } : {}),
    });
    return EXIT_SUCCESS;
  }
  const entries = Object.entries(snapshot.documents);
  console.log(entries.length === 1 && !snapshot.history ? entries[0]![1].content : entries.map(([path, doc]) => `===== ${path} =====\n${doc.content}`).join("\n"));
  for (const entry of snapshot.history ?? []) {
    console.log(`History of ${entry.path}:`);
    console.log(entry.changes.length > 0 ? entry.changes.map(renderChange).join("\n") : "  (no changes in the versions searched)");
  }
  if (snapshot.missing?.length) console.error(red(`draft context read: not found: ${snapshot.missing.join(", ")}`));
  return EXIT_SUCCESS;
}

export async function runContextRead(args: string[]): Promise<number> {
  const parsed = parseReadArgs(args);
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft context read: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }
  if (parsed.paths) return runPathRead(parsed);

  if (parsed.period) {
    const dimension = parsed.dimensions![0];
    const result = await fetchWorkspaceContext({ dimension, period: parsed.period, versionId: parsed.versionId });
    if (!result.ok) {
      printFetchError("draft context read", result.code, parsed.json);
      return EXIT_OPERATIONAL_ERROR;
    }
    const entry = Object.entries(result.snapshot.documents)[0];
    if (!entry) {
      printFetchError("draft context read", "period_not_found", parsed.json);
      return EXIT_OPERATIONAL_ERROR;
    }
    const [path, doc] = entry;
    if (parsed.json) {
      printJsonLine({
        ...snapshotMeta(result.snapshot),
        documents: [{ name: dimension, path, content: doc.content, sha256: doc.sha256 }],
      });
      return EXIT_SUCCESS;
    }
    renderHuman(result.snapshot, [{ name: dimension, path }]);
    return EXIT_SUCCESS;
  }

  const result = await fetchWorkspaceContext(parsed.versionId ? { versionId: parsed.versionId } : undefined);
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
        printJsonLine({ ...snapshotMeta(result.snapshot), documents: [] });
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
      ...snapshotMeta(result.snapshot),
      documents: selected.map((d) => ({ name: d.name, path: d.path, content: result.snapshot.documents[d.path]?.content ?? "", sha256: result.snapshot.documents[d.path]?.sha256 })),
    });
    return EXIT_SUCCESS;
  }

  renderHuman(result.snapshot, selected);
  return EXIT_SUCCESS;
}

interface ParsedExportArgs {
  out?: string;
  zip?: string;
  force: boolean;
  json: boolean;
  error?: string;
}

function parseExportArgs(args: string[]): ParsedExportArgs {
  let json = false;
  let force = false;
  const values: Record<"out" | "zip", string | undefined> = { out: undefined, zip: undefined };
  const fail = (error: string): ParsedExportArgs => ({ json, force, error });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--force") { force = true; continue; }
    const flag = (["out", "zip"] as const).find((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (flag) {
      const result = readValueFlag(args, i, flag);
      if ("error" in result) return fail(result.error);
      values[flag] = result.value;
      i = result.nextIndex;
      continue;
    }
    return fail(arg.startsWith("--") ? `unknown flag: ${arg}` : `unexpected positional argument: ${arg}`);
  }
  const { out, zip } = values;
  if (out !== undefined && zip !== undefined) return fail("--out and --zip are mutually exclusive");
  if (out === "" || zip === "") return fail("--out and --zip need a non-empty path");
  return { out, zip, force, json };
}

function exportErrorPayload(error: ContextExportError) {
  const action = error.code === "folder_not_empty" || error.code === "file_exists" ? "--force" : undefined;
  return errorPayload(error.code, error.message, action);
}

export async function runContextExport(args: string[]): Promise<number> {
  const parsed = parseExportArgs(args);
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft context export: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  // Loaded on demand so other commands don't pay for the zip library.
  const exporter = await import("../utils/context-export.ts");
  const result = await fetchContextExport();
  if (!result.ok) {
    printFetchError("draft context export", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  let path: string;
  let fileCount: number;
  let versionNumber: number | null;
  try {
    const entries = exporter.readExportEntries(result.bytes);
    fileCount = entries.length;
    versionNumber = exporter.exportVersionNumber(entries);
    if (parsed.zip !== undefined) {
      exporter.writeExportZip(result.bytes, parsed.zip, parsed.force);
      path = parsed.zip;
    } else {
      path = parsed.out ?? "draft-context";
      exporter.writeExportFolder(entries, path, parsed.force);
    }
  } catch (error) {
    if (!(error instanceof exporter.ContextExportError)) throw error;
    const payload = exportErrorPayload(error);
    if (parsed.json) printJsonLine(payload);
    else console.error(red(`draft context export: ${payload.message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  if (parsed.json) {
    printJsonLine({ path, fileCount, versionNumber });
    return EXIT_SUCCESS;
  }
  console.log(`Exported ${fileCount} files${versionNumber === null ? "" : ` (version ${versionNumber})`} to ${path}`);
  if (parsed.zip === undefined) console.log(`Point an agent at it, e.g. cd ${path} && claude`);
  return EXIT_SUCCESS;
}

export async function runContext(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list": return runContextList(rest);
    case "read": return runContextRead(rest);
    case "export": return runContextExport(rest);
    default:
      console.error(red(`draft context: unknown subcommand${sub ? ` "${sub}"` : ""}. Use list, read or export.`));
      return EXIT_USAGE_ERROR;
  }
}
