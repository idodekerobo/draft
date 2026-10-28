import { splitAuthor } from "draft-core/live-sessions";
import type { StreamItem } from "./stream-items";
import type { ComposerInput, LiveSessionEvent } from "./types";

export type PendingItem = Extract<StreamItem, { type: "pending" }>;

// Event rows can reach the server before the input moves to consumed, and clocks differ.
const CLOCK_SLACK_MS = 60_000;

/** Messages that are on their way to Claude, as items for the end of the stream. A message the log already holds is left out. */
export function pendingItems(
  inputs: ComposerInput[],
  events: LiveSessionEvent[],
  context: { viewerName: string; ownerName: string; hostOffline: boolean },
): PendingItem[] {
  const turns = events
    .filter((event) => event.kind === "user_message" && !event.payload.agent_id && typeof event.payload.text === "string")
    .map((event) => ({ text: splitAuthor(event.payload.text as string).text.trim(), at: Date.parse(event.created_at) }));
  const taken = new Set<number>();

  return inputs
    .filter((input) => input.state === "sending" || input.state === "queued" || input.state === "delivering")
    .filter((input) => {
      const since = Date.parse(input.created_at) - CLOCK_SLACK_MS;
      const index = turns.findIndex((turn, i) => !taken.has(i) && turn.text === input.text.trim() && turn.at >= since);
      if (index === -1) return true;
      taken.add(index);
      return false;
    })
    .map((input) => ({
      type: "pending" as const,
      key: input.key ?? input.id,
      input,
      author: input.mine ? context.viewerName : input.author_name,
      ownerName: context.ownerName,
      hostOffline: context.hostOffline,
    }));
}
