import { harnessLabel, isTestedVersion, testedVersionLabel } from "draft-core/harnesses";
import { isDraftCloudSession } from "./place";
import type { LiveSession } from "./types";

/** The one line shown under the header, or null. A computer that is offline comes before the version warning. */
export function sessionBanner(session: Pick<LiveSession, "status" | "owner_name" | "harness" | "harness_version" | "execution_target">, devOnly = false): string | null {
  if (session.status === "host_offline" && !isDraftCloudSession(session)) {
    return `${session.owner_name ?? "The owner"}'s computer is offline. Messages wait until it is back.`;
  }
  const harness = session.harness ?? "claude";
  if (devOnly && session.status !== "ended" && isTestedVersion(harness, session.harness_version) === false) {
    return `[DEV ONLY] This session runs ${harnessLabel(harness)} ${session.harness_version}. Draft was tested with ${testedVersionLabel(harness)}, so some things may not work.`;
  }
  return null;
}
