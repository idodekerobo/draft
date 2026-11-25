// commands/home.ts — draft home needs-you, and draft notifications list|done|not-mine|undo.
// Each command is the MCP tool of the same name; --json prints that tool's answer.

import { callPersonTool, runModeErrorMessage } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

const HOME_HELP = `${bold("draft home")} — what needs you.

usage: draft home needs-you [--json]

Lists what needs you now, newest first: open approvals, questions an agent asked you,
your open to-dos, and failed sends from routines you own.`;

const NOTIFICATIONS_HELP = `${bold("draft notifications")} — your own notifications.

usage: draft notifications list [--needs-action] [--json]
       draft notifications done <id> [--json]
       draft notifications not-mine <id> [--json]
       draft notifications undo <id> [--json]

  list         Your notifications, newest first. --needs-action keeps those waiting on you.
  done         Mark one done. Repeating it changes nothing.
  not-mine     Say a routed to-do is not yours. The routine owner gets a card to reassign it.
  undo         Take back done or not-mine, unless a later action was taken.`;

type Notification = { id: string; kind: string; subject: string; state: string; needsAction: boolean; createdAt: string };
type NeedsYouRow =
  | { kind: "approval"; sessionId: string; title: string | null; openCount: number; createdAt: string }
  | { kind: "input_request"; id: string; question: string; createdAt: string }
  | { kind: "notification"; notification: Notification; createdAt: string }
  | { kind: "connection_attention"; provider: string; status: string; createdAt: string }
  | { kind: "failed_delivery"; subject: string; channel: string; status: string; createdAt: string };

function fail(command: string, json: boolean, code: string, message: string, exitCode: number): number {
  if (json) printJsonLine(errorPayload(code, message));
  else console.error(red(`${command}: ${message}`));
  return exitCode;
}

async function call(command: string, json: boolean, tool: string, input: Record<string, unknown>): Promise<Record<string, unknown> | number> {
  const result = await callPersonTool(tool, input);
  if (result.ok) return result.output as Record<string, unknown>;
  const code = result.toolStatus ? (result.refusal ?? result.code) : result.code;
  const message = result.toolStatus ? (result.message ?? "The call was refused.") : runModeErrorMessage(code) ?? (code === "not_authenticated" ? "Not signed in. Run `draft auth login`." : "Could not reach Draft. Retry shortly.");
  return fail(command, json, code, message, EXIT_OPERATIONAL_ERROR);
}

function describeRow(row: NeedsYouRow): string {
  switch (row.kind) {
    case "approval": return `Approval  ${row.title ?? "A session"} (${row.openCount} waiting)  ${dim(`draft sessions read ${row.sessionId}`)}`;
    case "input_request": return `Question  ${row.question}`;
    case "notification": return `${row.notification.kind === "todo_routed" ? "To-do" : "Action"}  ${row.notification.subject}  ${dim(row.notification.id)}`;
    case "connection_attention": return `Reconnect  ${row.provider} (${row.status})  ${dim(`draft connections connect --provider ${row.provider}`)}`;
    case "failed_delivery": return `Failed send  ${row.subject} (${row.channel}: ${row.status})`;
  }
}

export async function runHome(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HOME_HELP);
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  const command = "draft home needs-you";
  const json = rest.includes("--json");
  if (sub !== "needs-you" || rest.some((arg) => arg !== "--json")) {
    console.error(red(`draft home: use "needs-you [--json]".`));
    return EXIT_USAGE_ERROR;
  }
  const output = await call(command, json, "home.needs_you", {});
  if (typeof output === "number") return output;
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  const { count = 0, rows = [] } = output as { count?: number; rows?: NeedsYouRow[] };
  console.log(count ? `${count} need${count === 1 ? "s" : ""} you:\n${rows.map(describeRow).join("\n")}` : "Nothing needs you right now.");
  return EXIT_SUCCESS;
}

const ACTIONS: Record<string, string> = { done: "notifications.done", "not-mine": "notifications.not_mine", undo: "notifications.undo" };

export async function runNotifications(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(NOTIFICATIONS_HELP);
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const command = `draft notifications ${sub}`;

  if (sub === "list") {
    if (rest.some((arg) => arg !== "--json" && arg !== "--needs-action")) return fail(command, json, "invalid_usage", "unexpected argument", EXIT_USAGE_ERROR);
    const output = await call(command, json, "notifications.list", rest.includes("--needs-action") ? { needsAction: true } : {});
    if (typeof output === "number") return output;
    if (json) {
      printJsonLine(output);
      return EXIT_SUCCESS;
    }
    const notifications = (output.notifications ?? []) as Notification[];
    console.log(notifications.length ? notifications.map((item) => `${item.createdAt}  ${item.state.padEnd(8)}  ${item.subject}  ${dim(item.id)}`).join("\n") : "No notifications.");
    return EXIT_SUCCESS;
  }

  const tool = ACTIONS[sub];
  if (!tool) return fail("draft notifications", json, "invalid_usage", `unknown subcommand "${sub}". Use list, done, not-mine or undo.`, EXIT_USAGE_ERROR);
  if (positional.length !== 1 || rest.some((arg) => arg.startsWith("--") && arg !== "--json")) return fail(command, json, "invalid_usage", "give one notification id", EXIT_USAGE_ERROR);
  const output = await call(command, json, tool, { notificationId: positional[0] });
  if (typeof output === "number") return output;
  if (json) {
    printJsonLine(output);
    return EXIT_SUCCESS;
  }
  console.log(output.changed === false ? `Already ${String(output.state)}.` : `Now ${String(output.state)}.`);
  return EXIT_SUCCESS;
}
