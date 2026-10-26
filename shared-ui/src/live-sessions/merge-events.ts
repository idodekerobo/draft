import type { LiveSessionEvent } from "./types";

/** Appends events above the current last seq; a repeated page changes nothing. */
export function mergeEvents(current: LiveSessionEvent[], incoming: LiveSessionEvent[]): LiveSessionEvent[] {
  const lastSeq = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((event) => event.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  return fresh.length === 0 ? current : [...current, ...fresh];
}
