import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyChannelId, NotifyResult } from "draft-core/notify";
import { recordError, redactString } from "../../errors/record-error";
import { sendNotification, type DeliveryRecorder } from "./send";
import { normalizeSubject } from "../channels/email/render";
import type { ChannelOutcome, NotifyChannel, ReachablePerson } from "./types";

const MAX_ERROR_DETAIL = 500;

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

const contentHash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

type SavedDelivery = { channel: NotifyChannelId; status: ChannelSendResult["status"]; error_code: string | null };
const toResult = (row: SavedDelivery): ChannelSendResult => row.status === "failed"
  ? { channel: row.channel, status: "failed", code: row.error_code === "not_reachable" ? "not_reachable" : "provider_error" }
  : { channel: row.channel, status: row.status };

function deliveryIdFor(notificationId: string, channel: NotifyChannelId): string {
  // The primary key is the cross-process claim for this notification and channel.
  const hex = createHash("sha256").update(`${notificationId}:${channel}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type LogError = (code: string, error: unknown, detail?: Record<string, unknown>) => Promise<void>;

function recorderFor(client: SupabaseClient, notificationId: string, workspaceId: string, logError: LogError): DeliveryRecorder {
  return {
    async begin(channel) {
      const id = deliveryIdFor(notificationId, channel);
      const { data, error } = await client.from("notification_deliveries").insert({ id, notification_id: notificationId, workspace_id: workspaceId, channel }).select("id").single();
      if (error?.code === "23505") {
        const saved = await client.from("notification_deliveries").select("channel, status, error_code").eq("id", id).eq("workspace_id", workspaceId).single();
        if (saved.error || !saved.data) throw saved.error ?? new Error("delivery_not_found");
        return { id, existing: toResult(saved.data as SavedDelivery) };
      }
      if (error || !data) throw error ?? new Error("delivery_not_created");
      return { id };
    },
    async finish(channel, deliveryId, outcome: ChannelOutcome, failure) {
      const now = new Date().toISOString();
      const update =
        outcome.status === "sent"
          ? { status: "sent", provider_message_id: outcome.providerMessageId ?? null, accepted_at: now, last_event_at: now, attempt_count: 1 }
          : {
              status: outcome.status,
              error_code: "code" in outcome ? outcome.code : outcome.status === "queued" ? "delivery_unknown" : null,
              error_detail: failure instanceof Error ? redactString(failure.message).slice(0, MAX_ERROR_DETAIL) : null,
              last_event_at: now,
              attempt_count: "code" in outcome && outcome.code === "not_reachable" ? 0 : 1,
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
 * Each channel is claimed before sending. An existing claim is never sent again automatically.
 */
export async function deliverNotification(
  client: SupabaseClient,
  channels: Record<NotifyChannelId, NotifyChannel>,
  person: ReachablePerson,
  input: DeliverInput,
): Promise<DeliverResult> {
  const wanted = [...new Set(input.requested?.length ? input.requested : person.notifyChannels)];
  const subject = normalizeSubject(input.subject);
  const hash = contentHash([person.id, subject, input.text, input.html ?? null, input.link ?? null, [...wanted].sort()]);
  const key = input.idempotencyKey ?? (input.origin.agentRunId ? `run:${input.origin.agentRunId}:${hash}` : `person:${randomUUID()}`);
  const logError: LogError = (code, error, detail) =>
    recordError({ client, workspaceId: person.workspaceId, agentRunId: input.origin.agentRunId, operation: "execution", code, message: `notification: ${code}`, detail: { personId: person.id, ...detail }, error });

  const find = async () => {
    const { data, error } = await client.from("notifications").select("id, content_hash, sender_user_id, agent_run_id").eq("workspace_id", person.workspaceId).eq("idempotency_key", key).maybeSingle();
    if (error) throw error;
    return data as { id: string; content_hash: string; sender_user_id: string | null; agent_run_id: string | null } | null;
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
  if (existing && (existing.content_hash !== hash || (existing.sender_user_id ?? null) !== input.origin.senderUserId || (!input.origin.senderUserId && (existing.agent_run_id ?? null) !== input.origin.agentRunId))) return { ok: false, code: "idempotency_conflict" };

  let saved: SavedDelivery[] = [];
  if (existing) {
    const response = await client.from("notification_deliveries").select("channel, status, error_code").eq("notification_id", notificationId).eq("workspace_id", person.workspaceId);
    if (response.error) throw response.error;
    saved = (response.data ?? []) as SavedDelivery[];
  }
  const remaining = wanted.filter((channel) => !saved.some((row) => row.channel === channel));
  const sent: NotifyResult = remaining.length
    ? await sendNotification(
        channels,
        person,
        { text: input.text, html: input.html, link: input.link, subject, attribution: input.attribution },
        remaining,
        (channel, error) => logError("notify_send_failed", error, { channel }),
        recorderFor(client, notificationId, person.workspaceId, logError),
      )
    : { results: [] };

  const results = wanted.map((channel) => {
    const old = saved.find((row) => row.channel === channel);
    return old ? toResult(old) : sent.results.find((result) => result.channel === channel)!;
  });
  return { ok: true, notificationId, results, duplicate: Boolean(existing) };
}
