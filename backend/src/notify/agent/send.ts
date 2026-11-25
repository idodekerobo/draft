import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotifyChannelId, NotifyResult } from "draft-core/notify";
import { isNotifyChannelId, NOTIFY_CHANNELS } from "draft-core/notify";
import { findToolPermission, type DraftToolLimits, type ToolCaller } from "draft-core/tools";
import { recordError } from "../../errors/record-error";
import { countRunToolCalls } from "../../people/limits";
import { attributionLine, originTaskId } from "./attribution";
import { isFailure, resolvePerson } from "../delivery/resolve-person";
import { deliverNotification } from "../delivery/deliver";
import { htmlToText, renderEmail, MAX_EMAIL_HTML_CHARS } from "../channels/email/render";
import type { NotifyChannel } from "../delivery/types";
import { messageFailure, type MessageResult } from "./result";
import { isSynthesisRun } from "draft-core/run-spec";

export const agentMessageSchema = z.object({
  personId: z.string().uuid().describe("The id of one active workspace teammate, from people.find. Never an email address."),
  text: z.string().min(1).max(2000).optional().describe("The message as plain text. Required unless html is given."),
  html: z.string().min(1).max(MAX_EMAIL_HTML_CHARS).optional().describe("Email only. A richer body. Plain text is made from it when text is omitted."),
  subject: z.string().min(1).max(140).optional().describe("Email only. A short, factual topic, without the 'Draft: ' prefix."),
  link: z.string().url().optional().describe("A URL appended to the plain text message on each channel."),
  idempotencyKey: z.string().min(1).max(128).optional().describe("A stable key for this message, so a retry does not send twice."),
  channels: z.array(z.enum(NOTIFY_CHANNELS)).min(1).optional().describe("Where to send. Omit to use the person's own channels."),
  kind: z.enum(["message", "todo"]).optional().describe("message (the default) just tells them. todo also puts a card on their Home that they mark Done, or Not mine if it is not theirs. A todo needs sourceItemId and quote."),
  sourceItemId: z.string().uuid().optional().describe("todo only. The source the to-do came from, from sources.search. A private source is allowed only if it is yours."),
  quote: z.string().min(1).max(500).optional().describe("todo only. The exact words from the source that assign the to-do to this person."),
  matchedIdentityId: z.string().uuid().optional().describe("todo only. The id of the person's identity (from people.find) that matched the name in the source, so a wrong match can be traced."),
});
export type AgentMessageInput = z.infer<typeof agentMessageSchema>;

export async function sendAgentMessage(client: SupabaseClient, channels: Record<NotifyChannelId, NotifyChannel>, caller: ToolCaller, rawInput: AgentMessageInput): Promise<MessageResult<NotifyResult>> {
  const parsed = agentMessageSchema.safeParse(rawInput);
  if (!parsed.success) return messageFailure("invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const workspaceId = caller.workspaceId;

  // The checks run in this order, and the first one that fails refuses the whole call.
  const person = await resolvePerson(client, workspaceId, input.personId);
  if (isFailure(person)) {
    const why = { person_not_found: "No person with that id in this workspace.", not_active: "That person is not active yet, so they cannot be messaged.", not_member: "Only teammates can be messaged." }[person.failure];
    return messageFailure("not_allowed", why);
  }

  if (caller.origin.kind === "run") {
    const { run } = caller.origin;
    const permission = findToolPermission(run, "people.notify");
    if (!permission) return messageFailure("not_permitted", "This run may not notify people.");
    const limits = permission.limits as DraftToolLimits["people.notify"] | undefined;
    const recipients = limits?.recipients ?? "self";
    const allowed = recipients === "members" || (recipients === "self" ? run.onBehalfOf !== null && person.userId === run.onBehalfOf : recipients.includes(person.id));
    if (!allowed) return messageFailure("not_allowed", recipients === "self" ? "This run may only message the person it works for." : "This run may not message that person.");
    const max = limits?.maxPerRun ?? (isSynthesisRun(run) ? undefined : 10);
    if (max !== undefined && (await countRunToolCalls(client, run.id, "people.notify")) >= max) return messageFailure("limit_reached", `This run has used people.notify ${max} times, which is its limit. Stop and report what is left.`);
  }

  const todo = await checkTodo(client, workspaceId, caller, person, input);
  if (todo && "failure" in todo) return todo.failure;

  const baseText = input.text ?? (input.html ? htmlToText(input.html) : "");
  const text = todo && input.quote ? `${baseText}\n\nFrom the source: "${input.quote}"` : baseText;
  const content = renderEmail({ subject: input.subject, text, html: input.html });
  if (!content.ok) {
    const why = { empty_body: "Give text, html, or both.", subject_too_long: "The subject is too long.", text_too_long: "The text is too long.", html_too_long: "The html is too long." }[content.code];
    return messageFailure("invalid_input", why);
  }

  const origin = caller.origin;
  const agentRunId = origin.kind === "run" ? origin.run.id : null;
  const logFailure = (code: string, error: unknown) =>
    recordError({ client, workspaceId, agentRunId, operation: "delivery", code, message: `people.notify: ${code}`, detail: { personId: person.id }, error });
  try {
    const delivered = await deliverNotification(client, channels, person, {
      subject: input.subject,
      text,
      html: input.html,
      link: input.link,
      idempotencyKey: input.idempotencyKey,
      attribution: await attributionLine(client, caller),
      action: todo ? { kind: "todo_routed", refType: "source_item", refId: todo.todo.sourceItemId, matchedIdentityId: todo.todo.matchedIdentityId } : undefined,
      requested: input.channels?.filter(isNotifyChannelId),
      origin: {
        senderUserId: origin.kind === "run" ? origin.run.onBehalfOf : origin.userId,
        agentRunId,
        scheduledTaskId: origin.kind === "run" ? await originTaskId(client, origin.run) : null,
      },
    });
    if (!delivered.ok) return messageFailure("idempotency_conflict", "That idempotencyKey was already used with different content. Use a new key for a different message.");
    const output: NotifyResult = { notificationId: delivered.notificationId, results: delivered.results };
    return { ok: true, output, summary: delivered.results.map((entry) => `${entry.channel}: ${entry.status}`).join(", ") };
  } catch (error) {
    await logFailure("notify_record_failed", error);
    return messageFailure("notify_failed", "The notification could not be prepared or its saved deliveries could not be read. Check its status before retrying.");
  }
}

/** A to-do must name its source and quote. The caller may not route a private source that is someone else's. */
async function checkTodo(
  client: SupabaseClient,
  workspaceId: string,
  caller: ToolCaller,
  person: { id: string },
  input: AgentMessageInput,
): Promise<{ todo: { sourceItemId: string; matchedIdentityId: string | null } } | { failure: MessageResult<NotifyResult> } | null> {
  if (input.kind !== "todo") {
    if (input.sourceItemId || input.quote || input.matchedIdentityId) return { failure: messageFailure("invalid_input", "sourceItemId, quote and matchedIdentityId are only for kind todo.") };
    return null;
  }
  if (!input.sourceItemId || !input.quote) return { failure: messageFailure("invalid_input", "A to-do needs sourceItemId and quote.") };

  const { data: source, error } = await client.from("source_items").select("visibility, owner_user_id").eq("id", input.sourceItemId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  const row = source as { visibility: "private" | "shared"; owner_user_id: string | null } | null;
  if (!row || (row.visibility === "private" && (!caller.onBehalfOf || row.owner_user_id !== caller.onBehalfOf))) {
    return { failure: messageFailure("not_allowed", "No source with that id that you may route a to-do from.") };
  }

  let matchedIdentityId: string | null = null;
  if (input.matchedIdentityId) {
    const { data: identity, error: identityError } = await client.from("person_identities").select("id").eq("id", input.matchedIdentityId).eq("workspace_id", workspaceId).eq("person_id", person.id).maybeSingle();
    if (identityError) throw identityError;
    if (!identity) return { failure: messageFailure("invalid_input", "That identity does not belong to this person.") };
    matchedIdentityId = input.matchedIdentityId;
  }
  return { todo: { sourceItemId: input.sourceItemId, matchedIdentityId } };
}
