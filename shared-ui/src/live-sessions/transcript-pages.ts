import type { LiveSessionEvent, SessionTranscriptPage } from "./types";

export function mergeTranscriptEvents(current: LiveSessionEvent[], incoming: LiveSessionEvent[]): LiveSessionEvent[] {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  let changed = false;
  for (const event of incoming) {
    const old = bySeq.get(event.seq);
    if (!old || JSON.stringify(old) !== JSON.stringify(event)) { bySeq.set(event.seq, event); changed = true; }
  }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : current;
}

export function mergeTranscriptPage(current: SessionTranscriptPage | undefined, incoming: SessionTranscriptPage, direction: "older" | "newer" = "newer"): SessionTranscriptPage {
  if (!current) return incoming;
  return {
    ...incoming,
    events: mergeTranscriptEvents(current.events, incoming.events),
    dependencies: mergeTranscriptEvents(current.dependencies, incoming.dependencies),
    before: direction === "older" ? incoming.before ?? current.before : current.before ?? incoming.before,
    after: direction === "older" ? current.after ?? incoming.after : incoming.after ?? current.after,
    hasOlder: direction === "older" ? incoming.hasOlder : current.hasOlder,
    hasNewer: direction === "older" ? current.hasNewer : incoming.hasNewer,
    through: direction === "older" ? current.through : incoming.through,
    readThrough: direction === "older" ? current.readThrough : incoming.readThrough,
  };
}

export const transcriptEvents = (page: SessionTranscriptPage) => mergeTranscriptEvents(page.events, page.dependencies);
