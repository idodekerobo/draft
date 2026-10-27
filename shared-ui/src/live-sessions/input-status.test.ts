import { describe, expect, it } from "bun:test";
import { inputStatusLine } from "./input-status";
import type { LiveSessionInput } from "./types";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const input = (patch: Partial<LiveSessionInput>): LiveSessionInput => ({
  id: "i", author_user_id: "u", author_name: "Priya", text: "hi", state: "queued", reason: null,
  created_at: "2026-10-27T11:59:30Z", updated_at: "2026-10-27T11:59:30Z", mine: true, ...patch,
});

describe("inputStatusLine", () => {
  it("shows a fresh queued message as waiting", () => {
    expect(inputStatusLine(input({}), "Maya", NOW)).toBe("Queued, waiting for Claude");
  });

  it("shows elapsed minutes after a minute", () => {
    expect(inputStatusLine(input({ created_at: "2026-10-27T11:48:00Z" }), "Maya", NOW)).toBe("Queued 12 min");
  });

  it("says the owner is typing in the terminal", () => {
    expect(inputStatusLine(input({ reason: "composer_busy" }), "Maya", NOW)).toBe("Queued, Maya is typing in the terminal");
  });

  it("says when Claude waits for a prompt", () => {
    expect(inputStatusLine(input({ reason: "permission_prompt" }), "Maya", NOW)).toBe("Queued, Claude is waiting for an approval");
    expect(inputStatusLine(input({ reason: "question_prompt" }), "Maya", NOW)).toBe("Queued, Claude is waiting for an answer");
  });

  it("covers sending, uncertain and failed", () => {
    expect(inputStatusLine(input({ state: "delivering" }), "Maya", NOW)).toBe("Sending…");
    expect(inputStatusLine(input({ state: "uncertain" }), "Maya", NOW)).toBe("May not have been delivered.");
    expect(inputStatusLine(input({ state: "failed", reason: "session_ended" }), "Maya", NOW)).toBe("Not delivered: the session ended");
    expect(inputStatusLine(input({ state: "failed", reason: "odd" }), "Maya", NOW)).toBe("Not delivered: something went wrong");
  });
});
