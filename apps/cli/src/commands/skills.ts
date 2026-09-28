// commands/skills.ts — draft skills add|update|remove|list|read
//
// Company-owned reusable procedures: a conversational agent's write path
// into the company brain, gated only by the same team membership that
// already governs `draft context`. See
// internal-docs/designs/company-harness-parallel-pilots.md for the mechanism.

import { readFileSync } from "fs";
import {
  addSkill,
  listSkills,
  readSkill,
  removeSkill,
  updateSkill,
  type AddOrUpdateSkillBody,
  type FetchErrorCode,
  type SkillDetail,
} from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

function fetchErrorPayload(code: FetchErrorCode) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  if (code === "skill_not_found") return errorPayload(code, "unknown skill — run `draft skills list` to see available names.");
  if (code === "duplicate_name") return errorPayload(code, "name already exists — use `draft skills update <name>`.");
  if (code === "invalid_name") return errorPayload(code, "invalid name: lowercase letters, numbers, hyphens only, 1-64 chars, no leading/trailing/consecutive hyphens.");
  if (code === "missing_required_fields") return errorPayload(code, "name and description required — pass --description (and a name argument), or include YAML frontmatter with name/description.");
  if (code === "missing_content") return errorPayload(code, "no content given — pass --file <path>, --content \"<text>\", or pipe content via stdin.");
  if (code === "malformed_frontmatter") return errorPayload(code, "invalid frontmatter: could not parse YAML.");
  return errorPayload(code, "Could not reach the skills API right now. Retry shortly.");
}

function printFetchError(command: string, code: FetchErrorCode, json: boolean): void {
  const payload = fetchErrorPayload(code);
  if (json) { printJsonLine(payload); return; }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
}

interface ContentSource {
  file?: string;
  content?: string;
}

interface ParsedContentArgs extends ContentSource {
  remaining: string[];
  error?: string;
}

function parseContentArgs(args: string[]): ParsedContentArgs {
  const remaining: string[] = [];
  let file: string | undefined;
  let content: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--file") {
      const value = args[++i];
      if (value === undefined) return { remaining, error: "--file requires a value" };
      file = value;
      continue;
    }
    if (arg.startsWith("--file=")) { file = arg.slice("--file=".length); continue; }
    if (arg === "--content") {
      const value = args[++i];
      if (value === undefined) return { remaining, error: "--content requires a value" };
      content = value;
      continue;
    }
    if (arg.startsWith("--content=")) { content = arg.slice("--content=".length); continue; }
    remaining.push(arg);
  }
  if (file !== undefined && content !== undefined) {
    return { remaining, error: "--file and --content are mutually exclusive" };
  }
  return { file, content, remaining };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type ContentResult = { ok: true; content: string } | { ok: false; message: string };

async function resolveContent(source: ContentSource): Promise<ContentResult> {
  if (source.file !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(source.file, "utf8");
    } catch {
      return { ok: false, message: `could not read file: ${source.file}` };
    }
    if (raw.trim().length === 0) return { ok: false, message: "file is empty or not valid text" };
    return { ok: true, content: raw };
  }
  if (source.content !== undefined) {
    if (source.content.trim().length === 0) return { ok: false, message: "--content is empty" };
    return { ok: true, content: source.content };
  }
  if (!process.stdin.isTTY) {
    const raw = await readStdin();
    if (raw.trim().length === 0) return { ok: false, message: "stdin is empty" };
    return { ok: true, content: raw };
  }
  return { ok: false, message: "no content given — pass --file <path>, --content \"<text>\", or pipe content via stdin" };
}

interface ParsedWriteArgs {
  name?: string;
  description?: string;
  file?: string;
  content?: string;
  json: boolean;
  error?: string;
}

function parseWriteArgs(args: string[], opts: { nameRequired: boolean }): ParsedWriteArgs {
  const contentParsed = parseContentArgs(args);
  if (contentParsed.error) return { json: args.includes("--json"), error: contentParsed.error };

  let json = false;
  let description: string | undefined;
  let name: string | undefined;
  const rest = contentParsed.remaining;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--description") {
      const value = rest[++i];
      if (value === undefined) return { json, error: "--description requires a value" };
      description = value;
      continue;
    }
    if (arg.startsWith("--description=")) { description = arg.slice("--description=".length); continue; }
    if (arg.startsWith("--")) return { json, error: `unknown flag: ${arg}` };
    if (name !== undefined) return { json, error: `unexpected argument: ${arg}` };
    name = arg;
    continue;
  }

  if (opts.nameRequired && name === undefined) return { json, error: "missing skill name" };

  return { name, description, file: contentParsed.file, content: contentParsed.content, json };
}

function printSkillDetail(skill: SkillDetail): void {
  console.log(`${bold(skill.name)}`);
  console.log(skill.description);
  if (skill.license) console.log(`${dim("license:")} ${skill.license}`);
  if (skill.compatibility) console.log(`${dim("compatibility:")} ${skill.compatibility}`);
  if (skill.allowedTools) console.log(`${dim("allowed-tools:")} ${skill.allowedTools}`);
  if (skill.metadata) console.log(`${dim("metadata:")} ${JSON.stringify(skill.metadata)}`);
  console.log("");
  console.log(skill.content);
}

export async function runSkillsList(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.find((a) => a !== "--json");
  if (unknown) {
    if (json) printJsonLine(errorPayload("invalid_usage", `unexpected argument: ${unknown}`));
    else console.error(red(`draft skills list: unexpected argument: ${unknown}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await listSkills();
  if (!result.ok) {
    printFetchError("draft skills list", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ skills: result.value.skills });
    return EXIT_SUCCESS;
  }

  if (result.value.skills.length === 0) {
    console.log("No skills found.");
    return EXIT_SUCCESS;
  }
  for (const skill of result.value.skills) {
    console.log(`${bold(skill.name)} — ${skill.description}`);
  }
  return EXIT_SUCCESS;
}

interface ParsedNameArg {
  json: boolean;
  name?: string;
  error?: string;
}

function parseSingleNameArg(args: string[], usage: string): ParsedNameArg {
  const json = args.includes("--json");
  const positionals = args.filter((a) => a !== "--json");
  if (positionals.length !== 1) return { json, error: `missing skill name — usage: ${usage}` };
  return { json, name: positionals[0] };
}

export async function runSkillsRead(args: string[]): Promise<number> {
  const parsed = parseSingleNameArg(args, "draft skills read <name>");
  const json = parsed.json;
  if (parsed.error) {
    if (json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft skills read: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await readSkill(parsed.name!);
  if (!result.ok) {
    printFetchError("draft skills read", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ skill: result.value });
    return EXIT_SUCCESS;
  }
  printSkillDetail(result.value);
  return EXIT_SUCCESS;
}

function buildSkillBody(parsed: ParsedWriteArgs, content: string): AddOrUpdateSkillBody {
  const body: AddOrUpdateSkillBody = { content };
  if (parsed.name !== undefined) body.name = parsed.name;
  if (parsed.description !== undefined) body.description = parsed.description;
  return body;
}

export async function runSkillsAdd(args: string[]): Promise<number> {
  const parsed = parseWriteArgs(args, { nameRequired: false });
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft skills add: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  const contentResult = await resolveContent({ file: parsed.file, content: parsed.content });
  if (!contentResult.ok) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", contentResult.message));
    else console.error(red(`draft skills add: ${contentResult.message}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await addSkill(buildSkillBody(parsed, contentResult.content));
  if (!result.ok) {
    printFetchError("draft skills add", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (parsed.json) {
    printJsonLine({ status: "ok", skill: result.value });
    return EXIT_SUCCESS;
  }
  console.log(`Saved skill ${bold(result.value.name)}.`);
  return EXIT_SUCCESS;
}

export async function runSkillsUpdate(args: string[]): Promise<number> {
  const parsed = parseWriteArgs(args, { nameRequired: true });
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft skills update: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  const contentResult = await resolveContent({ file: parsed.file, content: parsed.content });
  if (!contentResult.ok) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", contentResult.message));
    else console.error(red(`draft skills update: ${contentResult.message}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await updateSkill(parsed.name!, buildSkillBody(parsed, contentResult.content));
  if (!result.ok) {
    printFetchError("draft skills update", result.code, parsed.json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (parsed.json) {
    printJsonLine({ status: "ok", skill: result.value });
    return EXIT_SUCCESS;
  }
  console.log(`Saved skill ${bold(result.value.name)}.`);
  return EXIT_SUCCESS;
}

export async function runSkillsRemove(args: string[]): Promise<number> {
  const parsed = parseSingleNameArg(args, "draft skills remove <name>");
  const json = parsed.json;
  if (parsed.error) {
    if (json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else console.error(red(`draft skills remove: ${parsed.error}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await removeSkill(parsed.name!);
  if (!result.ok) {
    printFetchError("draft skills remove", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ status: "ok", name: parsed.name });
    return EXIT_SUCCESS;
  }
  console.log(`Removed skill ${bold(parsed.name!)}.`);
  return EXIT_SUCCESS;
}

function printSkillsHelp(): void {
  console.log(`${bold("draft skills")} — the company's skill marketplace: reusable procedures any agent can discover and follow.`);
  console.log("");
  console.log("Usage:");
  console.log("  draft skills list");
  console.log("  draft skills read <name>");
  console.log("  draft skills add [<name>] [--description \"<when to use this>\"] (--file <path> | --content \"<text>\" | stdin)");
  console.log("  draft skills update <name> [--description \"<text>\"] (--file <path> | --content \"<text>\" | stdin)");
  console.log("  draft skills remove <name>");
  console.log("");
  console.log("name/description are optional on `add` when the content starts with");
  console.log("standard YAML frontmatter (SKILL.md-style: `---\\nname: ...\\ndescription: ...\\n---`).");
  console.log("Explicit flags always override parsed frontmatter values.");
  console.log("");
  console.log("Names must match ^[a-z0-9]+(-[a-z0-9]+)*$, max 64 chars.");
  console.log("Write the description the way you'd write a skill's own SKILL.md description.");
}

export async function runSkills(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printSkillsHelp();
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  switch (sub) {
    case "list": return runSkillsList(rest);
    case "read": return runSkillsRead(rest);
    case "add": return runSkillsAdd(rest);
    case "update": return runSkillsUpdate(rest);
    case "remove": return runSkillsRemove(rest);
    default:
      console.error(red(`draft skills: unknown subcommand "${sub}". Use list, read, add, update, or remove.`));
      return EXIT_USAGE_ERROR;
  }
}
