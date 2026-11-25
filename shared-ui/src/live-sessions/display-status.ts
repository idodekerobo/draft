import { isSandboxSession } from "./place";
import type { LiveSession } from "./types";

export type DisplayStatusKey = "starting" | "waking" | "live" | "idle" | "waiting" | "host_offline" | "sleeping" | "ended";

export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
}

export const IDLE_AFTER_MS = 60 * 60_000;

const STATUSES: Record<DisplayStatusKey, DisplayStatus> = {
  starting: { key: "starting", label: "Starting" },
  waking: { key: "waking", label: "Waking up" },
  live: { key: "live", label: "Live" },
  idle: { key: "idle", label: "Idle" },
  waiting: { key: "waiting", label: "Waiting for approval" },
  host_offline: { key: "host_offline", label: "Host offline" },
  sleeping: { key: "sleeping", label: "Sleeping" },
  ended: { key: "ended", label: "Ended" },
};

/**
 * The one status a person sees. Host offline and sleeping win over Waiting for approval, which wins over the stored
 * state, because neither an offline host nor a sleeping session can answer. Idle is not stored: a live session with no event for an hour.
 * A cloud session that starts with events already counted has woken from sleep: the server only sets `starting` again on a wake.
 */
export function displayStatus(
  session: Pick<LiveSession, "status" | "open_approval_count" | "last_event_at" | "started_at"> & Partial<Pick<LiveSession, "execution_target" | "last_seq">>,
  now: number,
): DisplayStatus {
  if (session.status === "ended") return STATUSES.ended;
  if (session.status === "host_offline") return isSandboxSession(session) ? { key: "host_offline", label: "Restarting" } : STATUSES.host_offline;
  if (session.status === "sleeping") return STATUSES.sleeping;
  if ((session.open_approval_count ?? 0) > 0) return STATUSES.waiting;
  if (session.status === "starting") {
    return isSandboxSession(session) && (session.last_seq ?? 0) > 0 ? STATUSES.waking : STATUSES.starting;
  }
  const lastActive = Date.parse(session.last_event_at ?? session.started_at);
  return now - lastActive > IDLE_AFTER_MS ? STATUSES.idle : STATUSES.live;
}
