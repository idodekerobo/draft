import { TESTED_CLAUDE_VERSION, isTestedClaudeVersion } from "draft-core/live-sessions";
import type { LiveSession } from "./types";

/** The one line shown under the header, or null. Host offline comes before the version warning. */
export function sessionBanner(session: Pick<LiveSession, "status" | "owner_name" | "harness_version">): string | null {
  if (session.status === "host_offline") {
    return `${session.owner_name ?? "The owner"}'s computer is offline. Messages wait until it is back.`;
  }
  if (session.status !== "ended" && isTestedClaudeVersion(session.harness_version) === false) {
    return `This session runs Claude Code ${session.harness_version}. Draft was tested with ${TESTED_CLAUDE_VERSION.major}.${TESTED_CLAUDE_VERSION.minor}.x, so some things may not work.`;
  }
  return null;
}
