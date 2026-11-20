import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyChannelId, NotifyResult } from "draft-core/notify";
import { recordError, redactString } from "../errors/record-error";
import { sendNotification, type DeliveryRecorder } from "./send";
import type { ChannelOutcome, NotifyChannel, ReachablePerson } from "./types";

const MAX_SUBJECT = 200;
const MAX_ERROR_DETAIL = 500;
const FALLBACK_SUBJECT = "New message";
const PREFIX = /^draft:\s*/i;

export type DeliverInput = {
  subject?: string;
  text: string;
  html?: string;
  link?: string;
  idempotencyKey?: string;
  attribution: string;
  requested?: ReadonlyArray<NotifyChannelId>;
  /** The human whose authority the send used, and where it came from. Both are set by the gateway, not the model. */
  origin: { senderUserId: string | null; agentRunId: string | null; scheduledTaskId: string | null };
};

export type DeliverResult =
  | { ok: true; notificationId: string; results: ReadonlyArray<ChannelSendResult>; duplicate: boolean }
  | { ok: false; code: "idempotency_conflict" };

/** The subject kept on the notification: what the agent wrote without the `Draft:` prefix, or the first line of the text. */
export function storedSubject(subject: string | undefined, text: string): string {
  const topic = (subject ?? "").replace(/\s+/g, " ").trim().replace(PREFIX, "").trim();
  if (topic) return topic.slice(0, MAX_SUBJECT);
  const line = text.split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean);
  return (line ?? FALLBACK_SUBJECT).slice(0, 80);
}

const contentHash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const toResult = (channel: string, status: string, code: string | null): ChannelSendResult =>
  status === "failed" ? { channel: channel as NotifyChannelId, status: "failed", code: code === "not_reachable" ? "not_reachable" : "provider_error" } : { channel: channel as NotifyChannelId, status: "sent" };

type LogError = (code: string, error: unknown, detail?: Record<string, unknown>) => Promise<void>;

function recorderFor(client: SupabaseClient, notificationId: string, workspaceId: string, logError: LogError): DeliveryRecorder {
  return {
    async begin(channel) {
      const { data, error } = await client.from("notification_deliveries").insert({ notification_id: notificationId, workspace_id: workspaceId, channel }).select("id").single();
      if (error || !data) throw error ?? new Error("delivery_not_created");
      return (data as { id: string }).id;
    },
    async finish(channel, deliveryId, outcome: ChannelOutcome, failure) {
      const now = new Date().toISOString();
      const update =
        outcome.status === "sent"
          ? { status: "sent", provider_message_id: outcome.providerMessageId ?? null, accepted_at: now, last_event_at: now, attempt_count: 1 }
          : {
              status: "failed",
              error_code: outcome.code,
              error_detail: failure instanceof Error ? redactString(failure.message).slice(0, MAX_ERROR_DETAIL) : null,
              last_event_at: now,
              attempt_count: outcome.code === "not_reachable" ? 0 : 1,
            };
      // The message may already be out, so a failed update is logged and does not change what the caller is told.
      const { error } = await client.from("notification_deliveries").update(update).eq("id", deliveryId).eq("workspace_id", workspaceId);
      if (error) await logError("notify_delivery_update_failed", error, { channel });
    },
  };
}

/**
 * Saves a notification and one delivery per channel, then sends. The same idempotency key with the same content returns
 * the saved notification and sends only the channels it has no delivery for yet. With different content it is refused.
 * Everything is saved before anything is sent, so a database failure means nothing went out.
 */
export async function deliverNotification(
  client: SupabaseClient,
  channels: Record<NotifyChannelId, NotifyChannel>,
  person: ReachablePerson,
  input: DeliverInput,
): Promise<DeliverResult> {
  const wanted = [...new Set(input.requested?.length ? input.requested : person.notifyChannels)];
  const subject = storedSubject(input.subject, input.text);
  const hash = contentHash([person.id, subject, input.text, input.html ?? null, input.link ?? null, [...wanted].sort()]);
  const key = input.idempotencyKey ?? (input.origin.agentRunId ? `run:${input.origin.agentRunId}:${hash}` : `person:${randomUUID()}`);
  const logError: LogError = (code, error, detail) =>
    recordError({ client, workspaceId: person.workspaceId, agentRunId: input.origin.agentRunId, operation: "execution", code, message: `people.notify: ${code}`, detail: { personId: person.id, ...detail }, error });

  const find = async () => {
    const { data, error } = await client.from("notifications").select("id, content_hash").eq("workspace_id", person.workspaceId).eq("idempotency_key", key).maybeSingle();
    if (error) throw error;
    return data as { id: string; content_hash: string } | null;
  };

  let existing = await find();
  let notificationId = existing?.id;
  if (!existing) {
    const { data, error } = await client
      .from("notifications")
      .insert({
        workspace_id: person.workspaceId,
        recipient_person_id: person.id,
        sender_user_id: input.origin.senderUserId,
        kind: "message",
        subject,
        body_text: input.text,
        body_html: input.html ?? null,
        link: input.link ?? null,
        visibility: "private",
        agent_run_id: input.origin.agentRunId,
        scheduled_task_id: input.origin.scheduledTaskId,
        idempotency_key: key,
        content_hash: hash,
      })
      .select("id")
      .single();
    if (error?.code === "23505") {
      existing = await find();
      notificationId = existing?.id;
    } else if (error || !data) {
      throw error ?? new Error("notification_not_created");
    } else {
      notificationId = (data as { id: string }).id;
    }
  }
  if (!notificationId) throw new Error("notification_not_found");
  if (existing && existing.content_hash !== hash) return { ok: false, code: "idempotency_conflict" };

  const saved = existing
    ? (((await client.from("notification_deliveries").select("channel, status, error_code").eq("notification_id", notificationId).eq("workspace_id", person.workspaceId)).data ?? []) as Array<{ channel: string; status: string; error_code: string | null }>)
    : [];
  const remaining = wanted.filter((channel) => !saved.some((row) => row.channel === channel));
  const sent: NotifyResult = remaining.length
    ? await sendNotification(
        channels,
        person,
        { text: input.text, html: input.html, link: input.link, subject: input.subject, attribution: input.attribution },
        remaining,
        (channel, error) => logError("notify_send_failed", error, { channel }),
        recorderFor(client, notificationId, person.workspaceId, logError),
      )
    : { results: [] };

  const results = wanted.map((channel) => {
    const old = saved.find((row) => row.channel === channel);
    return old ? toResult(channel, old.status, old.error_code) : sent.results.find((result) => result.channel === channel)!;
  });
  return { ok: true, notificationId, results, duplicate: Boolean(existing) };
}

/** The routine a run belongs to. A scheduled run names it in its trigger. Any other run is tied to it through its own row. */
export async function originTaskId(client: SupabaseClient, run: { id: string; trigger: { type: string; scheduledTaskId?: string } }): Promise<string | null> {
  if (run.trigger.type === "cron" && run.trigger.scheduledTaskId) return run.trigger.scheduledTaskId;
  const { data, error } = await client.from("agent_runs").select("scheduled_task_id").eq("id", run.id).maybeSingle();
  if (error) throw error;
  return (data as { scheduled_task_id: string | null } | null)?.scheduled_task_id ?? null;
}
