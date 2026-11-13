import type { LiveSessionEvent, LiveSessionEventsPage } from "./types";

/** Appends events above the current last seq; a repeated page changes nothing. */
export function mergeEvents(current: LiveSessionEvent[], incoming: LiveSessionEvent[]): LiveSessionEvent[] {
  const lastSeq = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((event) => event.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  return fresh.length === 0 ? current : [...current, ...fresh];
}

/** Fills in the author of a message that reached the viewer before the server linked it to its sender. */
export function patchAuthors(events: LiveSessionEvent[], authors: LiveSessionEventsPage["authors"]): LiveSessionEvent[] {
  if (!authors?.length) return events;
  const bySeq = new Map(authors.map((author) => [author.seq, author]));
  let changed = false;
  const patched = events.map((event) => {
    const author = event.kind === "user_message" ? bySeq.get(event.seq) : undefined;
    if (!author || (event.author_user_id === author.author_user_id && event.author_name === author.author_name)) return event;
    changed = true;
    return { ...event, author_user_id: author.author_user_id, author_name: author.author_name };
  });
  return changed ? patched : events;
}
