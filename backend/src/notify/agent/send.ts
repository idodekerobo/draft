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

  const text = input.text ?? (input.html ? htmlToText(input.html) : "");
  const content = renderEmail({ subject: input.subject, text, html: input.html });
  if (!content.ok) {
    const why = { empty_body: "Give text, html, or both.", subject_too_long: "The subject is too long.", text_too_long: "The text is too long.", html_too_long: "The html is too long." }[content.code];
    return messageFailure("invalid_input", why);
  }

  const origin = caller.origin;
  const agentRunId = origin.kind === "run" ? origin.run.id : null;
  const logFailure = (code: string, error: unknown) =>
    recordError({ client, workspaceId, agentRunId, operation: "execution", code, message: `people.notify: ${code}`, detail: { personId: person.id }, error });
  try {
    const delivered = await deliverNotification(client, channels, person, {
      subject: input.subject,
      text,
      html: input.html,
      link: input.link,
      idempotencyKey: input.idempotencyKey,
      attribution: await attributionLine(client, caller),
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
