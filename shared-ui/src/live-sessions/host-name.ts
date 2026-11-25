import { isDraftCloudSession } from "./place";
import type { LiveSession } from "./types";

/** Older cloud and routine sessions stored this label before the app named the place from the execution target. */
const LEGACY_CLOUD_HOST = "Draft cloud";

/** Where a session runs, as the app shows it: Draft Cloud for a cloud session, else the computer's name. */
export function displayHostName(session: Pick<LiveSession, "host_name"> & Partial<Pick<LiveSession, "execution_target">>): string | null {
  if (isDraftCloudSession(session) || session.host_name === LEGACY_CLOUD_HOST) return "Draft Cloud";
  return session.host_name || null;
}
