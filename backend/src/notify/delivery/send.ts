import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyChannelId, NotifyMessage, NotifyResult } from "draft-core/notify";
import { emailChannel } from "../channels/email/send";
import { slackChannel } from "../channels/slack/send";
import { DeliveryUncertainError, type ChannelOutcome, type NotifyChannel, type ReachablePerson } from "./types";

/** Every channel Draft can send on. A new channel is one file implementing NotifyChannel and one line here. */
export function defaultChannels(client: SupabaseClient): Record<NotifyChannelId, NotifyChannel> {
  return { slack: slackChannel(client), email: emailChannel(client) };
}

/** Keeps a record of each send. `begin` runs before a channel is tried, `finish` after, with the thrown error when there was one. */
export interface DeliveryRecorder {
  begin(channel: NotifyChannelId): Promise<{ id: string; existing?: ChannelOutcome }>;
  finish(channel: NotifyChannelId, deliveryId: string, outcome: ChannelOutcome, error?: unknown): Promise<void>;
}

/**
 * Sends one message to a checked person on each channel, inline, one result per channel. A channel that cannot
 * reach them reports `not_reachable` and does not stop the others. With no channels named, the person's own are used.
 * `onFailure` hears about each thrown error, so the caller can log it. `not_reachable` is expected and is not reported.
 */
export async function sendNotification(
  channels: Record<NotifyChannelId, NotifyChannel>,
  person: ReachablePerson,
  message: NotifyMessage,
  requested?: ReadonlyArray<NotifyChannelId>,
  onFailure?: (channel: NotifyChannelId, error: unknown) => Promise<void> | void,
  recorder?: DeliveryRecorder,
): Promise<NotifyResult> {
  const wanted = [...new Set(requested?.length ? requested : person.notifyChannels)];
  const results: ChannelSendResult[] = [];
  for (const id of wanted) {
    const channel = channels[id];
    let claim: { id: string; existing?: ChannelOutcome } | undefined;
    try {
      claim = await recorder?.begin(id);
    } catch (error) {
      await onFailure?.(id, error);
      results.push({ channel: id, status: "failed", code: "recording_error" });
      continue;
    }
    if (claim?.existing) {
      const { providerMessageId: _kept, ...result } = claim.existing;
      results.push(result);
      continue;
    }
    const deliveryId = claim?.id;
    let outcome: ChannelOutcome;
    let failure: unknown;
    try {
      outcome = (await channel.canReach(person)) ? await channel.send(person, message, { deliveryId }) : { channel: id, status: "failed", code: "not_reachable" };
    } catch (error) {
      failure = error;
      await onFailure?.(id, error);
      outcome = error instanceof DeliveryUncertainError ? { channel: id, status: "queued" } : { channel: id, status: "failed", code: "provider_error" };
    }
    if (recorder && deliveryId) {
      try {
        await recorder.finish(id, deliveryId, outcome, failure);
      } catch (error) {
        await onFailure?.(id, error);
      }
    }
    const { providerMessageId: _kept, ...result } = outcome;
    results.push(result);
  }
  return { results };
}
