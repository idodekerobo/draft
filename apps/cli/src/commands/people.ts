// commands/people.ts — draft people find | create | pending | approve | reject | notify
//
// Who the workspace's people are, and how to reach them. Each command is one Draft tool, called as the
// signed-in person. An agent that adds a person leaves them pending; an admin decides here.

import { callPersonTool, type FetchErrorCode } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PersonView {
  id: string;
  displayName: string;
  status: string;
  isUser: boolean;
  reachable: { slack: boolean };
}

interface Flags {
  positionals: string[];
  json: boolean;
  me: boolean;
  force: boolean;
  values: Record<string, string>;
  error?: string;
}

const VALUE_FLAGS = new Set(["email", "slack", "quote", "status", "reason", "link", "channel", "name"]);
const BOOLEAN_FLAGS = new Set(["json", "me", "force"]);

function parseFlags(args: string[]): Flags {
  const flags: Flags = { positionals: [], json: false, me: false, force: false, values: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { flags.positionals.push(arg); continue; }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(rawName)) { (flags as unknown as Record<string, boolean>)[rawName] = true; continue; }
    if (!VALUE_FLAGS.has(rawName)) return { ...flags, error: `unknown flag: ${arg}` };
    const value = inline ?? args[++i];
    if (value === undefined) return { ...flags, error: `--${rawName} requires a value` };
    flags.values[rawName] = value;
  }
  return flags;
}

function transportError(code: FetchErrorCode) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  return errorPayload(code, "Could not reach the people API right now. Retry shortly.");
}

function fail(command: string, json: boolean, payload: ReturnType<typeof errorPayload>, exitCode = EXIT_OPERATIONAL_ERROR): number {
  if (json) printJsonLine(payload);
  else console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
  return exitCode;
}

function usage(command: string, json: boolean, message: string): number {
  return fail(command, json, errorPayload("invalid_usage", message), EXIT_USAGE_ERROR);
}

async function call(command: string, json: boolean, tool: string, input: Record<string, unknown>): Promise<{ output: unknown } | number> {
  const result = await callPersonTool(tool, input);
  if (result.ok) return { output: result.output };
  if (result.toolStatus) return fail(command, json, errorPayload(result.refusal ?? result.code, result.message ?? "The request did not work."));
  return fail(command, json, transportError(result.code));
}

const people = (output: unknown): PersonView[] => {
  const list = (output as { people?: unknown } | null)?.people;
  return Array.isArray(list) ? (list as PersonView[]) : [];
};

function printPerson(person: PersonView): void {
  const tags = [person.status, person.isUser ? "has an account" : "no account", person.reachable.slack ? "Slack" : null].filter(Boolean).join(", ");
  console.log(`${bold(person.displayName)} ${dim(`(${tags})`)}  ${dim(person.id)}`);
}

function printPeople(list: PersonView[], empty: string): void {
  if (list.length === 0) console.log(empty);
  for (const person of list) printPerson(person);
}

export async function runPeopleFind(args: string[]): Promise<number> {
  const command = "draft people find";
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  if (flags.positionals.length > 1) return usage(command, flags.json, "give one name, or use --email");

  const result = await call(command, flags.json, "people.find", {
    ...(flags.me ? { me: true } : {}),
    ...(flags.positionals[0] ? { name: flags.positionals[0] } : {}),
    ...(flags.values.email ? { email: flags.values.email } : {}),
    ...(flags.values.status ? { status: flags.values.status } : {}),
  });
  if (typeof result === "number") return result;
  if (flags.json) printJsonLine({ people: people(result.output) });
  else printPeople(people(result.output), "No people found.");
  return EXIT_SUCCESS;
}

export async function runPeoplePending(args: string[]): Promise<number> {
  const command = "draft people pending";
  const flags = parseFlags(args);
  if (flags.error || flags.positionals.length) return usage(command, flags.json, flags.error ?? `unexpected argument: ${flags.positionals[0]}`);
  const result = await call(command, flags.json, "people.find", { status: "pending" });
  if (typeof result === "number") return result;
  if (flags.json) printJsonLine({ people: people(result.output) });
  else printPeople(people(result.output), "Nobody is waiting for approval.");
  return EXIT_SUCCESS;
}

export async function runPeopleCreate(args: string[]): Promise<number> {
  const command = "draft people create";
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [name, ...extra] = flags.positionals;
  if (!name || extra.length) return usage(command, flags.json, "usage: draft people create <name> [--email <address>] [--slack <member id>] [--quote <why>] [--force]");

  const identities = [
    ...(flags.values.email ? [{ provider: "email", externalId: flags.values.email }] : []),
    ...(flags.values.slack ? [{ provider: "slack", externalId: flags.values.slack }] : []),
  ];
  const result = await call(command, flags.json, "people.create", {
    displayName: name,
    evidence: { quote: flags.values.quote ?? "Added from the Draft CLI" },
    ...(identities.length ? { identities } : {}),
    ...(flags.force ? { force: true } : {}),
  });
  if (typeof result === "number") return result;

  const outcome = result.output as { created: boolean; person?: PersonView; candidates?: PersonView[]; rejected?: boolean };
  if (flags.json) { printJsonLine(outcome); return EXIT_SUCCESS; }
  if (outcome.created && outcome.person) {
    console.log(outcome.person.status === "pending" ? "Added. They wait for an admin to approve them." : "Added.");
    printPerson(outcome.person);
  } else if (outcome.rejected) {
    console.log("Nothing added: a person with this name was rejected before.");
  } else if (outcome.candidates) {
    console.log("Nothing added: Draft already knows people with a similar name. Pass --force if this is someone else.");
    printPeople(outcome.candidates, "");
  } else if (outcome.person) {
    console.log("Nothing added: Draft already knows this person.");
    printPerson(outcome.person);
  }
  return EXIT_SUCCESS;
}

/** Turns an id or a name into one person id. A name has to match exactly one pending person. */
async function resolvePending(command: string, json: boolean, who: string): Promise<{ id: string } | number> {
  if (UUID.test(who)) return { id: who };
  const result = await call(command, json, "people.find", { name: who, status: "pending" });
  if (typeof result === "number") return result;
  const matches = people(result.output);
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return fail(command, json, errorPayload("person_not_found", `Nobody pending matches "${who}". Run \`draft people pending\`.`));
  return fail(command, json, errorPayload("ambiguous_person", `More than one pending person matches "${who}". Use an id: ${matches.map((p) => `${p.displayName} ${p.id}`).join("; ")}`));
}

async function decide(args: string[], tool: "people.approve" | "people.reject", command: string): Promise<number> {
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [who, ...extra] = flags.positionals;
  if (!who || extra.length) return usage(command, flags.json, `usage: ${command} <id or name>${tool === "people.reject" ? " [--reason <why>]" : ""}`);

  const target = await resolvePending(command, flags.json, who);
  if (typeof target === "number") return target;
  const result = await call(command, flags.json, tool, { personId: target.id, ...(flags.values.reason ? { reason: flags.values.reason } : {}) });
  if (typeof result === "number") return result;

  const person = (result.output as { person: PersonView }).person;
  if (flags.json) printJsonLine({ person });
  else console.log(`${tool === "people.approve" ? "Approved" : "Rejected"} ${person.displayName}.`);
  return EXIT_SUCCESS;
}

export const runPeopleApprove = (args: string[]) => decide(args, "people.approve", "draft people approve");
export const runPeopleReject = (args: string[]) => decide(args, "people.reject", "draft people reject");

export async function runPeopleNotify(args: string[]): Promise<number> {
  const command = "draft people notify";
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [who, ...words] = flags.positionals;
  const text = words.join(" ").trim();
  if (!who || !text) return usage(command, flags.json, "usage: draft people notify <id or name> <message> [--link <url>] [--channel slack]");

  let personId = who;
  if (!UUID.test(who)) {
    const found = await call(command, flags.json, "people.find", { name: who, status: "active" });
    if (typeof found === "number") return found;
    const matches = people(found.output);
    if (matches.length !== 1) {
      return fail(command, flags.json, errorPayload(matches.length ? "ambiguous_person" : "person_not_found", matches.length ? `More than one person matches "${who}". Use an id.` : `Nobody active matches "${who}".`));
    }
    personId = matches[0]!.id;
  }
  const result = await call(command, flags.json, "people.notify", {
    personId,
    text,
    ...(flags.values.link ? { link: flags.values.link } : {}),
    ...(flags.values.channel ? { channels: [flags.values.channel] } : {}),
  });
  if (typeof result === "number") return result;

  const results = (result.output as { results?: Array<{ channel: string; status: string; code?: string }> }).results ?? [];
  if (flags.json) { printJsonLine({ results }); return EXIT_SUCCESS; }
  for (const entry of results) console.log(`${entry.channel}: ${entry.status === "sent" ? "sent" : `not sent (${entry.code ?? "failed"})`}`);
  return results.some((entry) => entry.status === "sent") ? EXIT_SUCCESS : EXIT_OPERATIONAL_ERROR;
}

function printPeopleHelp(): void {
  console.log(`${bold("draft people")} — the people in the workspace, and how to reach them.`);
  console.log("");
  console.log("Usage:");
  console.log(`  draft people find [name] [--me] [--email <address>] [--status <s>] [--json]   ${dim("Find people")}`);
  console.log(`  draft people create <name> [--email <a>] [--slack <id>] [--quote <why>] [--force]   ${dim("Add a teammate (pending unless you are an admin)")}`);
  console.log(`  draft people pending [--json]   ${dim("Who is waiting for approval")}`);
  console.log(`  draft people approve <id or name>   ${dim("Admins only")}`);
  console.log(`  draft people reject <id or name> [--reason <why>]   ${dim("Admins only")}`);
  console.log(`  draft people notify <id or name> <message> [--link <url>]   ${dim("Send a message to a person")}`);
}

export async function runPeople(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printPeopleHelp();
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  if (sub === "find") return runPeopleFind(rest);
  if (sub === "create") return runPeopleCreate(rest);
  if (sub === "pending") return runPeoplePending(rest);
  if (sub === "approve") return runPeopleApprove(rest);
  if (sub === "reject") return runPeopleReject(rest);
  if (sub === "notify") return runPeopleNotify(rest);
  console.error(red(`draft people: unknown subcommand "${sub}". Use find, create, pending, approve, reject or notify.`));
  return EXIT_USAGE_ERROR;
}
