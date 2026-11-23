/**
 * The shared contract for product notifications and messages sent for callers.
 * Draft sends to a checked person on their channels and reports each delivery.
 */
import type { PersonId } from "./run-spec";

/** A closed set, so a switch that misses a channel fails the build. Add "whatsapp" or "app" here. */
export const NOTIFY_CHANNELS = ["slack", "email"] as const;
export type NotifyChannelId = (typeof NOTIFY_CHANNELS)[number];

export const isNotifyChannelId = (value: unknown): value is NotifyChannelId =>
  NOTIFY_CHANNELS.some((channel) => channel === value);

/**
 * `subject` and `html` apply to email only. Slack sends `text` and `link` and ignores those fields.
 * `idempotencyKey` deduplicates the whole notification, across its channels.
 * For email, `text` or `html` is enough: the missing one is made from the other.
 * `attribution` says which agent, person, or product sent it. Channels put it at the end of what they send, and it is not stored with the body.
 */
export type NotifyMessage = { text?: string; link?: string; subject?: string; html?: string; idempotencyKey?: string; attribution?: string };

export type NotifyRequest = {
  personId: PersonId;
  message: NotifyMessage;
  /** Where to notify. Omitted means the person's own notify_channels. */
  channels?: ReadonlyArray<NotifyChannelId>;
};

export type ChannelSendResult =
  | { channel: NotifyChannelId; status: "queued" | "sent" | "delayed" | "delivered" | "bounced" | "complained" }
  | { channel: NotifyChannelId; status: "failed"; code: "not_reachable" | "provider_error" | "recording_error" };

/** `notificationId` is Draft's own id for the notification. Use it to check delivery later. */
export type NotifyResult = { notificationId?: string; results: ReadonlyArray<ChannelSendResult> };
