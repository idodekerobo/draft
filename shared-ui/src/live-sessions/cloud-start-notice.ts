import type { HostWait } from "./input-status";
import type { LiveSession } from "./types";

type NoticeSession = Pick<LiveSession, "status" | "started_at" | "folder_name"> & Partial<Pick<LiveSession, "runtime" | "last_seq" | "end_reason">>;

export interface CloudStartNotice {
  tone: "progress" | "error";
  title: string;
  detail: string;
}

/** End reasons of a cloud session that never got going. */
const START_FAILURES: Record<string, string> = {
  seed_failed: "The repository could not be copied in. Check the branch name and that Draft's GitHub app can reach the repository.",
  start_failed: "The machine could not be set up.",
  launch_failed: "Claude Code could not start in the machine.",
  host_failed: "The machine stopped while it was starting.",
};

/** A cloud session has woken from sleep when it starts with events already counted. */
const isWaking = (session: NoticeSession) => (session.last_seq ?? 0) > 0;

/** Why messages wait for the host right now, if they do. */
export function hostWaitOf(session: NoticeSession): HostWait {
  const cloud = session.runtime === "cloud";
  if (session.status === "host_offline") return cloud ? "cloud" : "local";
  if (cloud && session.status === "starting") return isWaking(session) ? "cloud_waking" : "cloud_starting";
  return false;
}

/** Elapsed time as m:ss. */
export function elapsedLabel(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What to show while a cloud session's machine starts or wakes, or why it never started. Null for anything else. */
export function cloudStartNotice(session: NoticeSession): CloudStartNotice | null {
  if (session.runtime !== "cloud") return null;
  if (session.status === "starting") {
    if (isWaking(session)) return { tone: "progress", title: "Waking this session", detail: "Its machine is starting again with your files as you left them. Messages send when it is ready." };
    const what = session.folder_name ? `copying in ${session.folder_name}` : "getting ready";
    return { tone: "progress", title: "Starting Draft cloud", detail: `Setting up a machine and ${what}. This usually takes under a minute. Your message sends when it is ready.` };
  }
  if (session.status === "ended" && !isWaking(session) && session.end_reason && START_FAILURES[session.end_reason]) {
    return { tone: "error", title: "This session could not start", detail: `${START_FAILURES[session.end_reason]} Start a new session to try again.` };
  }
  return null;
}
