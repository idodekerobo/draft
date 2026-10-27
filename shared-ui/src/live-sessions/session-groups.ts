import type { LiveSession, LiveSessionStatus } from "./types";

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

/** "now", "5m", "3h", "2d", then a date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_WORDS: Record<LiveSessionStatus, string> = {
  starting: "Starting",
  live: "Live",
  host_offline: "Host offline",
  ended: "Ended",
};

export const sessionStatusLabel = (status: LiveSessionStatus) => STATUS_WORDS[status];
