import type { LiveSessionInput } from "./types";

const BLOCKED: Record<string, string> = {
  permission_prompt: "Claude is waiting for an approval",
  question_prompt: "Claude is waiting for an answer",
  dialog: "Claude is waiting on a prompt",
};

const FAILED: Record<string, string> = {
  session_ended: "the session ended",
  pane_unavailable: "the session was not reachable",
};

/** Text to show the sender of an unfinished message. */
export function inputStatusLine(input: LiveSessionInput, ownerName: string, now = Date.now()): string {
  switch (input.state) {
    case "queued": {
      if (input.reason === "composer_busy") return `Queued, ${ownerName} is typing in the terminal`;
      const blocked = input.reason ? BLOCKED[input.reason] : undefined;
      if (blocked) return `Queued, ${blocked}`;
      const minutes = Math.floor((now - Date.parse(input.created_at)) / 60_000);
      return minutes >= 1 ? `Queued ${minutes} min` : "Queued, waiting for Claude";
    }
    case "delivering":
      return "Sending…";
    case "uncertain":
      return "May not have been delivered.";
    case "failed":
      return `Not delivered: ${(input.reason && FAILED[input.reason]) ?? "something went wrong"}`;
  }
}
