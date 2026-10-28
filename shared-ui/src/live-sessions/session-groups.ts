import type { LiveSession } from "./types";

export interface SessionGroup {
  label: "Today" | "Yesterday" | "Earlier";
  sessions: LiveSession[];
}

/** When the session last had activity. A session with no events yet counts from its start. */
export const lastActivityAt = (session: Pick<LiveSession, "last_event_at" | "started_at">) => session.last_event_at ?? session.started_at;

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Most recently active first, grouped by the local calendar day of the last activity. Empty groups are left out. */
export function groupSessionsByDay(sessions: LiveSession[], now = new Date()): SessionGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(new Date(today - 1));
  const groups: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  const sorted = [...sessions].sort((a, b) => Date.parse(lastActivityAt(b)) - Date.parse(lastActivityAt(a)));
  for (const session of sorted) {
    const day = dayStart(new Date(lastActivityAt(session)));
    groups[day >= today ? 0 : day >= yesterday ? 1 : 2]!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
