import { harnessLabel } from "draft-core/harnesses";
import type { InputBlockReason, InputFailReason } from "draft-core/live-sessions";
import type { ComposerInput } from "./types";

/** "Claude" for Claude Code, "Codex" for Codex. */
const shortName = (harness: string) => harnessLabel(harness).split(" ")[0]!;

const BLOCKED: Partial<Record<InputBlockReason, string>> = {
  permission_prompt: "is waiting for an approval",
  question_prompt: "is waiting for an answer",
  dialog: "is waiting on a prompt",
};

const FAILED: Partial<Record<InputFailReason, string>> = {
  session_ended: "the session ended",
  session_cleared: "the conversation was cleared",
  pane_unavailable: "the session was not reachable",
};

/** True when a queued message waits for a reason a person can act on, not just for the host to pick it up. */
export function isBlocked(input: ComposerInput, hostOffline = false): boolean {
  if (input.state !== "queued") return false;
  return hostOffline || input.reason === "composer_busy" || BLOCKED[input.reason as InputBlockReason] !== undefined;
}

/** Text to show the sender of an unfinished message. */
export function inputStatusLine(input: ComposerInput, ownerName: string, now = Date.now(), hostOffline = false, harness = "claude"): string {
  switch (input.state) {
    case "queued": {
      if (hostOffline) return `Queued, ${ownerName}'s laptop is offline`;
      if (input.reason === "composer_busy") return harness === "claude" ? `Queued, ${ownerName} is typing in the terminal` : `Queued, ${shortName(harness)} is working`;
      const blocked = BLOCKED[input.reason as InputBlockReason];
      if (blocked) return `Queued, ${shortName(harness)} ${blocked}`;
      const minutes = Math.floor((now - Date.parse(input.created_at)) / 60_000);
      return minutes >= 1 ? `Queued ${minutes} min` : `Queued, waiting for ${shortName(harness)}`;
    }
    case "sending":
    case "delivering":
      return "Sending…";
    case "uncertain":
      return "May not have been delivered.";
    case "failed":
      return `Not delivered: ${FAILED[input.reason as InputFailReason] ?? "something went wrong"}`;
  }
}
