// commands/people.ts — draft people find | create | update | pending | approve | reject | notify | notification-status
//
// Who the workspace's people are, and how to reach them. Each command is one Draft tool, called as the
// signed-in person. An agent that adds a person leaves them pending; an admin decides here.

import { readFileSync } from "node:fs";
import { callPersonTool, runModeErrorMessage, type FetchErrorCode } from "../cloud-client.ts";
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

const VALUE_FLAGS = new Set(["email", "slack", "quote", "status", "reason", "link", "channel", "name", "provider", "external-id", "handle", "source-item", "replace", "remove", "subject", "html-file", "idempotency-key"]);
const IDENTITY_PROVIDERS = ["email", "slack", "linear", "github", "whatsapp"] as const;
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
  const runMode = runModeErrorMessage(code);
  if (runMode) return errorPayload(code, runMode);
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

/** Turns an id or a name into one person. A name has to match exactly one person, whatever their status. */
async function resolvePerson(command: string, json: boolean, who: string): Promise<{ id: string; name: string | null } | number> {
  if (UUID.test(who)) return { id: who, name: null };
  const result = await call(command, json, "people.find", { name: who });
  if (typeof result === "number") return result;
  const matches = people(result.output);
  if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.displayName };
  if (matches.length === 0) return fail(command, json, errorPayload("person_not_found", `Nobody matches "${who}". Run \`draft people find\`.`));
  return fail(command, json, errorPayload("ambiguous_person", `More than one person matches "${who}". Use an id: ${matches.map((p) => `${p.displayName} ${p.id}`).join("; ")}`));
}

export async function runPeopleUpdate(args: string[]): Promise<number> {
  const command = "draft people update";
  const shape = [
    "usage: draft people update <id or name> --provider <email|slack|linear|github|whatsapp> --external-id <id> [--handle <name>] [--quote <why>] [--source-item <id>]",
    "       draft people update <id or name> --provider <p> --replace <wrong id> --external-id <right id>",
    "       draft people update <id or name> --provider <p> --remove <id>",
  ].join("\n");
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [who, ...extra] = flags.positionals;
  const { provider, handle, quote } = flags.values;
  const externalId = flags.values["external-id"];
  const replaces = flags.values.replace;
  const remove = flags.values.remove;
  const sourceItemId = flags.values["source-item"];
  if (!who || extra.length || !provider) return usage(command, flags.json, shape);
  const adding = externalId !== undefined && replaces === undefined && remove === undefined;
  const replacing = externalId !== undefined && replaces !== undefined && remove === undefined;
  const removing = remove !== undefined && externalId === undefined && replaces === undefined && handle === undefined && quote === undefined && sourceItemId === undefined;
  if (!adding && !replacing && !removing) return usage(command, flags.json, `give one change: add, replace or remove, never a mix\n${shape}`);
  if (!(IDENTITY_PROVIDERS as readonly string[]).includes(provider)) return usage(command, flags.json, `unknown provider "${provider}". Providers: ${IDENTITY_PROVIDERS.join(", ")}`);
  if (sourceItemId && !UUID.test(sourceItemId)) return usage(command, flags.json, "--source-item must be a source item id from `draft sources search`");

  const target = await resolvePerson(command, flags.json, who);
  if (typeof target === "number") return target;
  const result = await call(command, flags.json, "people.update", {
    personId: target.id,
    provider,
    ...(removing ? { remove } : { externalId, ...(replacing ? { replaces } : {}) }),
    ...(handle ? { handle } : {}),
    ...(removing ? {} : { evidence: { quote: quote ?? "Added from the Draft CLI", ...(sourceItemId ? { sourceItemId } : {}) } }),
  });
  if (typeof result === "number") return result;

  const outcome = (result.output as { outcome?: string } | null)?.outcome;
  if (flags.json) {
    printJsonLine({ outcome, personId: target.id, provider, ...(removing ? { removed: remove } : { externalId, ...(replacing ? { replaced: replaces } : {}) }) });
    return EXIT_SUCCESS;
  }
  const name = target.name ?? target.id;
  if (removing) console.log(`Removed the ${provider} identity ${remove} from ${name}.`);
  else if (outcome === "replaced") console.log(`Replaced the ${provider} identity ${replaces} with ${externalId} for ${name}. The new one is a guess until a connection sees the same id, so it cannot be used to message them yet.`);
  else if (outcome === "created") console.log(`Added the ${provider} identity ${externalId} to ${name}. It is a guess until a connection sees the same id, so it cannot be used to message them yet.`);
  else console.log(`${name} already has the ${provider} identity ${externalId}. Nothing changed.`);
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

const NOTIFY_USAGE = "usage: draft people notify <id or name> [<message>] [--channel slack|email|slack,email] [--subject <topic>] [--html-file <path>] [--link <url>] [--idempotency-key <key>] [--json]";

function printNotifyHelp(): void {
  console.log(`${bold("draft people notify")} — send a message to one active teammate, on Slack, by email, or both.`);
  console.log("");
  console.log("Usage:");
  console.log(`  ${NOTIFY_USAGE.replace("usage: ", "")}`);
  console.log("");
  console.log("Content:");
  console.log("  <message>            Plain text. Required unless --html-file is given.");
  console.log("  --html-file <path>   Email only. A richer body. If you give no message, the plain text is made from the HTML.");
  console.log("  --subject <topic>    Email only. A short, factual topic. Draft adds the \"Draft: \" prefix once, so leave it out.");
  console.log("                       Without one, a text-only email is titled \"Draft: New message\".");
  console.log("  --link <url>         A link added after the message.");
  console.log("  Slack uses the message text and ignores the subject and HTML. A line naming the sender ends every message.");
  console.log("");
  console.log("Delivery:");
  console.log("  <id or name>         One active teammate. Names must match exactly one person; email addresses come from verified identities.");
  console.log("  --channel            Where to send. Leave it out to use the person's own channels. Give one or both, such as slack,email.");
  console.log("  --idempotency-key    A stable key such as meeting-123-followups. A retry returns saved channel results and sends only channels without a delivery record.");
  console.log("                       The same key with different content is refused.");
  console.log("                       Recorded failures are not retried by repeating the call.");
  console.log("  --json               Print machine-readable output. It does not change what is sent.");
  console.log("  --help, -h           Show this help without sending a message.");
  console.log("  With run credentials, act as the agent run under its recipient and send limits; otherwise act as the signed-in person.");
  console.log("");
  console.log("The result has a notification id and one line per channel. For email, sent means the provider accepted it, not that it arrived.");
  console.log(`Check delivery with ${bold("draft people notification-status <notification id>")}.`);
  console.log("");
  console.log("Examples:");
  console.log("  draft people notify \"Ada Lovelace\" \"Your research is ready\" --channel email");
  console.log("  draft people notify <id> --channel email --subject \"Your meeting follow-ups\" --html-file ./notification.html --idempotency-key meeting-123-followups --json");
  console.log("  Subjects arrive as: Draft: Your meeting follow-ups · Draft: Review needed for the launch plan · Draft: Weekly research update");
}

export async function runPeopleNotify(args: string[]): Promise<number> {
  const command = "draft people notify";
  if (args.includes("--help") || args.includes("-h")) { printNotifyHelp(); return EXIT_SUCCESS; }
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [who, ...words] = flags.positionals;
  const text = words.join(" ").trim();
  const htmlFile = flags.values["html-file"];
  if (!who || (!text && !htmlFile)) return usage(command, flags.json, NOTIFY_USAGE);

  let html: string | undefined;
  if (htmlFile) {
    try {
      html = readFileSync(htmlFile, "utf8");
    } catch {
      return fail(command, flags.json, errorPayload("html_file_unreadable", `Could not read ${htmlFile}.`));
    }
  }

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
  const channels = flags.values.channel?.split(",").map((channel) => channel.trim()).filter(Boolean);
  const result = await call(command, flags.json, "people.notify", {
    personId,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(flags.values.subject ? { subject: flags.values.subject } : {}),
    ...(flags.values.link ? { link: flags.values.link } : {}),
    ...(flags.values["idempotency-key"] ? { idempotencyKey: flags.values["idempotency-key"] } : {}),
    ...(channels?.length ? { channels } : {}),
  });
  if (typeof result === "number") return result;

  const { notificationId, results = [] } = result.output as { notificationId?: string; results?: Array<{ channel: string; status: string; code?: string }> };
  if (flags.json) { printJsonLine({ notificationId, results }); return EXIT_SUCCESS; }
  for (const entry of results) console.log(`${entry.channel}: ${entry.status === "sent" ? "sent" : `not sent (${entry.code ?? "failed"})`}`);
  if (notificationId && results.some((entry) => entry.status === "sent")) console.log(`Notification ${notificationId}. Check delivery: draft people notification-status ${notificationId}`);
  return results.some((entry) => entry.status === "sent") ? EXIT_SUCCESS : EXIT_OPERATIONAL_ERROR;
}

export async function runPeopleNotificationStatus(args: string[]): Promise<number> {
  const command = "draft people notification-status";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${bold(command)} — check a notification without sending it again.`);
    console.log(`Usage: ${command} <notification id> [--json]`);
    console.log("Use the notificationId returned by draft people notify. You may read your sent and received notifications, and shared notifications.");
    console.log("With run credentials, the run's permissions and the person it works for determine access.");
    console.log("Statuses: queued, sent, delivered, delayed, bounced, complained, failed.");
    console.log("For email, sent means provider acceptance; delivered means acceptance by the recipient's mail server, not inbox placement or reading.");
    console.log("If the latest status cannot be fetched, the saved status is returned with refreshed: false.");
    console.log("--json prints the notificationId, refreshed flag, and per-channel deliveries. --help or -h shows this help.");
    return EXIT_SUCCESS;
  }
  const flags = parseFlags(args);
  if (flags.error) return usage(command, flags.json, flags.error);
  const [notificationId, ...extra] = flags.positionals;
  if (!notificationId || extra.length || !UUID.test(notificationId)) return usage(command, flags.json, "usage: draft people notification-status <notification id> [--json]");

  const result = await call(command, flags.json, "people.notification_status", { notificationId });
  if (typeof result === "number") return result;

  const status = result.output as { notificationId: string; refreshed: boolean; deliveries: Array<{ channel: string; status: string; errorCode: string | null }> };
  if (flags.json) { printJsonLine(status); return EXIT_SUCCESS; }
  for (const delivery of status.deliveries) console.log(`${delivery.channel}: ${delivery.status}${delivery.errorCode ? ` (${delivery.errorCode})` : ""}`);
  if (!status.refreshed) console.log(dim("The latest status could not be fetched, so this is the last saved one."));
  return EXIT_SUCCESS;
}

function printPeopleHelp(): void {
  console.log(`${bold("draft people")} — the people in the workspace, and how to reach them.`);
  console.log("");
  console.log("Usage:");
  console.log(`  draft people find [name] [--me] [--email <address>] [--status <s>] [--json]   ${dim("Find people")}`);
  console.log(`  draft people create <name> [--email <a>] [--slack <id>] [--quote <why>] [--force]   ${dim("Add a teammate (pending unless you are an admin)")}`);
  console.log(`  draft people update <id or name> --provider <p> --external-id <id> [--handle <name>] [--quote <why>] [--source-item <id>]   ${dim("Record another way to recognise a person")}`);
  console.log(`  draft people update <id or name> --provider <p> --replace <wrong id> --external-id <right id>   ${dim("Correct one in a single step")}`);
  console.log(`  draft people update <id or name> --provider <p> --remove <id>   ${dim("Remove one (only a guess can be changed)")}`);
  console.log(`  draft people pending [--json]   ${dim("Who is waiting for approval")}`);
  console.log(`  draft people approve <id or name>   ${dim("Admins only")}`);
  console.log(`  draft people reject <id or name> [--reason <why>]   ${dim("Admins only")}`);
  console.log(`  draft people notify <id or name> <message> [--channel slack|email] [--subject <topic>] [--html-file <path>] [--link <url>] [--idempotency-key <key>]   ${dim("Send a message (see draft people notify --help)")}`);
  console.log(`  draft people notification-status <notification id> [--json]   ${dim("Check whether a message was delivered")}`);
}

export async function runPeople(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printPeopleHelp();
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  if (sub === "find") return runPeopleFind(rest);
  if (sub === "create") return runPeopleCreate(rest);
  if (sub === "update") return runPeopleUpdate(rest);
  if (sub === "pending") return runPeoplePending(rest);
  if (sub === "approve") return runPeopleApprove(rest);
  if (sub === "reject") return runPeopleReject(rest);
  if (sub === "notify") return runPeopleNotify(rest);
  if (sub === "notification-status") return runPeopleNotificationStatus(rest);
  console.error(red(`draft people: unknown subcommand "${sub}". Use find, create, update, pending, approve, reject, notify or notification-status.`));
  return EXIT_USAGE_ERROR;
}
