import type { LiveSession } from "./types";

export interface SessionGroup {
  label: "Today" | "Yesterday" | "Earlier";
  sessions: LiveSession[];
}

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Newest first, grouped by the local calendar day the session started. Empty groups are left out. */
export function groupSessionsByDay(sessions: LiveSession[], now = new Date()): SessionGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(new Date(today - 1));
  const groups: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  const sorted = [...sessions].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  for (const session of sorted) {
    const day = dayStart(new Date(session.started_at));
    groups[day >= today ? 0 : day >= yesterday ? 1 : 2]!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
