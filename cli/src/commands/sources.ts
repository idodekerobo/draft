import type { SourceReadInput, SourceSearchInput, SourceRepresentation } from "draft-core/sources";
import { fetchSourceRead, fetchSourcesSearch } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { cyan, red } from "../utils/output.ts";

function printHelp(): void {
  console.log("Search and read cross-provider source evidence. Context is Draft's maintained business map; sources are direct stored evidence.");
  console.log("");
  console.log(`Usage: ${cyan("draft sources")} <COMMAND> [ARGS]`);
  console.log("");
  console.log("Commands:");
  console.log("  search <query> [--provider <p>] [--type <t[,t...]>] [--since <UTC>] [--until <UTC>] [--limit <n>] [--max-bytes <n>] [--cursor <opaque>] [--json]");
  console.log("  read <source_item_id> [--representation default|transcript|messages|structured] [--max-bytes <n>] [--cursor <opaque>] [--json]");
  console.log("");
  console.log("Search covers the stored default representation, which can be a summary, rendered source, or mixed content. A transcript may be readable without being searchable. The calling agent owns investigation and answer generation.");
}

function valueAfter(args: string[], index: number, flag: string): { value?: string; next: number; error?: string } {
  const arg = args[index]!;
  if (arg === flag) {
    const value = args[index + 1];
    return value === undefined ? { next: index, error: `${flag} requires a value` } : { value, next: index + 1 };
  }
  return { value: arg.slice(flag.length + 1), next: index };
}

function printFailure(command: string, code: string, json: boolean): number {
  const payload = errorPayload(code, code === "not_authenticated" ? "Not signed in." : "Could not complete the source request.", code === "not_authenticated" ? "draft auth login" : undefined);
  if (json) printJsonLine(payload);
  else console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
  return EXIT_OPERATIONAL_ERROR;
}

async function runSearch(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let query: string | undefined;
  const input: Partial<SourceSearchInput> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    const flag = ["--provider", "--type", "--since", "--until", "--limit", "--max-bytes", "--cursor"].find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag) {
      const parsed = valueAfter(args, i, flag);
      if (parsed.error) return usage(`draft sources search: ${parsed.error}`, json);
      i = parsed.next;
      const value = parsed.value!;
      if (flag === "--provider") input.provider = value;
      else if (flag === "--type") input.type = value.split(",").filter(Boolean);
      else if (flag === "--since") input.since = value;
      else if (flag === "--until") input.until = value;
      else if (flag === "--limit") input.limit = Number(value);
      else if (flag === "--max-bytes") input.max_bytes = Number(value);
      else input.cursor = value;
      continue;
    }
    if (arg.startsWith("--")) return usage(`draft sources search: unknown flag: ${arg}`, json);
    if (query !== undefined) return usage(`draft sources search: unexpected argument: ${arg}; quote multi-word queries`, json);
    query = arg;
  }
  if (!query) return usage("draft sources search: missing query", json);
  const result = await fetchSourcesSearch({ ...input, query });
  if (!result.ok) return printFailure("draft sources search", result.code, json);
  if (json) printJsonLine(result.value);
  else {
    for (const row of result.value.results) {
      console.log(`${row.source_item_id}  ${row.provider}/${row.item_type}  ${row.occurred_at}`);
      if (row.title) console.log(row.title);
      console.log(row.content);
      console.log("");
    }
    if (result.value.next_cursor) console.log(`More results: --cursor ${result.value.next_cursor}`);
  }
  return EXIT_SUCCESS;
}

async function runRead(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let sourceItemId: string | undefined;
  const input: Partial<SourceReadInput> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    const flag = ["--representation", "--max-bytes", "--cursor"].find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag) {
      const parsed = valueAfter(args, i, flag);
      if (parsed.error) return usage(`draft sources read: ${parsed.error}`, json);
      i = parsed.next;
      if (flag === "--representation") input.representation = parsed.value as SourceRepresentation;
      else if (flag === "--max-bytes") input.max_bytes = Number(parsed.value);
      else input.cursor = parsed.value;
      continue;
    }
    if (arg.startsWith("--")) return usage(`draft sources read: unknown flag: ${arg}`, json);
    if (sourceItemId !== undefined) return usage(`draft sources read: unexpected argument: ${arg}`, json);
    sourceItemId = arg;
  }
  if (!sourceItemId) return usage("draft sources read: missing source_item_id", json);
  const result = await fetchSourceRead({ ...input, source_item_id: sourceItemId });
  if (!result.ok) return printFailure("draft sources read", result.code, json);
  if (json) printJsonLine(result.value);
  else {
    process.stdout.write(result.value.content);
    if (!result.value.content.endsWith("\n")) process.stdout.write("\n");
    if (result.value.next_cursor) console.log(`Continue: --cursor ${result.value.next_cursor}`);
  }
  return EXIT_SUCCESS;
}

function usage(message: string, json: boolean): number {
  if (json) printJsonLine(errorPayload("invalid_usage", message));
  else console.error(red(message));
  return EXIT_USAGE_ERROR;
}

export async function runSources(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return EXIT_SUCCESS; }
  const [subcommand, ...rest] = args;
  if (subcommand === "search") return runSearch(rest);
  if (subcommand === "read") return runRead(rest);
  return usage(`draft sources: unknown subcommand${subcommand ? ` "${subcommand}"` : ""}. Use search or read.`, args.includes("--json"));
}
