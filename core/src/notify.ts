/**
 * The contract for telling a person something. A run asks Draft to notify a person;
 * Draft sends it on the channels the person has, and says what happened on each.
 */
import type { PersonId } from "./run-spec";

/** A closed set, so a switch that misses a channel fails the build. Add "whatsapp", "email" or "app" here. */
export const NOTIFY_CHANNELS = ["slack"] as const;
export type NotifyChannelId = (typeof NOTIFY_CHANNELS)[number];

export const isNotifyChannelId = (value: unknown): value is NotifyChannelId =>
  NOTIFY_CHANNELS.some((channel) => channel === value);

export type NotifyMessage = { text: string; link?: string };

export type NotifyRequest = {
  personId: PersonId;
  message: NotifyMessage;
  /** Where to notify. Omitted means the person's own notify_channels. */
  channels?: ReadonlyArray<NotifyChannelId>;
};

export type ChannelSendResult =
  | { channel: NotifyChannelId; status: "sent" }
  | { channel: NotifyChannelId; status: "failed"; code: "not_reachable" | "provider_error" };

export type NotifyResult = { results: ReadonlyArray<ChannelSendResult> };
