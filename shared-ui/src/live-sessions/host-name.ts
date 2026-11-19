import type { LiveSession } from "./types";

/** Older cloud and routine sessions stored this label before the app named the place from `runtime`. */
const LEGACY_CLOUD_HOST = "Draft cloud";

/** Where a session runs, as the app shows it: Draft Cloud for a cloud session, else the computer's name. */
export function displayHostName(session: Pick<LiveSession, "host_name"> & Partial<Pick<LiveSession, "runtime">>): string | null {
  if (session.runtime === "cloud" || session.host_name === LEGACY_CLOUD_HOST) return "Draft Cloud";
  return session.host_name || null;
}
