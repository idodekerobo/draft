import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyChannelId, NotifyMessage, NotifyResult } from "draft-core/notify";
import { slackChannel } from "./slack";
import type { NotifyChannel, ReachablePerson } from "./types";

/** Every channel Draft can send on. A new channel is one file implementing NotifyChannel and one line here. */
export function defaultChannels(client: SupabaseClient): Record<NotifyChannelId, NotifyChannel> {
  return { slack: slackChannel(client) };
}

/**
 * Sends one message to a checked person on each channel, inline, one result per channel. A channel that cannot
 * reach them reports `not_reachable` and does not stop the others. With no channels named, the person's own are used.
 */
export async function sendNotification(
  channels: Record<NotifyChannelId, NotifyChannel>,
  person: ReachablePerson,
  message: NotifyMessage,
  requested?: ReadonlyArray<NotifyChannelId>,
): Promise<NotifyResult> {
  const wanted = [...new Set(requested?.length ? requested : person.notifyChannels)];
  const results: ChannelSendResult[] = [];
  for (const id of wanted) {
    const channel = channels[id];
    try {
      results.push((await channel.canReach(person)) ? await channel.send(person, message) : { channel: id, status: "failed", code: "not_reachable" });
    } catch {
      results.push({ channel: id, status: "failed", code: "provider_error" });
    }
  }
  return { results };
}
