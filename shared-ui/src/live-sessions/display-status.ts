import type { LiveSession } from "./types";

export type DisplayStatusKey = "starting" | "live" | "idle" | "waiting" | "host_offline" | "ended";

export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
}

export const IDLE_AFTER_MS = 60 * 60_000;

const STATUSES: Record<DisplayStatusKey, DisplayStatus> = {
  starting: { key: "starting", label: "Starting" },
  live: { key: "live", label: "Live" },
  idle: { key: "idle", label: "Idle" },
  waiting: { key: "waiting", label: "Waiting for approval" },
  host_offline: { key: "host_offline", label: "Host offline" },
  ended: { key: "ended", label: "Ended" },
};

/**
 * The one status a person sees. Host offline wins over Waiting for approval, which wins over the stored
 * state, because an offline laptop cannot answer. Idle is not stored: a live session with no event for an hour.
 */
export function displayStatus(
  session: Pick<LiveSession, "status" | "open_approval_count" | "last_event_at" | "started_at">,
  now: number,
): DisplayStatus {
  if (session.status === "ended") return STATUSES.ended;
  if (session.status === "host_offline") return STATUSES.host_offline;
  if ((session.open_approval_count ?? 0) > 0) return STATUSES.waiting;
  if (session.status === "starting") return STATUSES.starting;
  const lastActive = Date.parse(session.last_event_at ?? session.started_at);
  return now - lastActive > IDLE_AFTER_MS ? STATUSES.idle : STATUSES.live;
}
