import { describe, expect, it } from "bun:test";
import { mergeEvents, patchAuthors } from "./merge-events";
import type { LiveSessionEvent } from "./types";

const event = (seq: number): LiveSessionEvent => ({
  seq,
  source_id: `s${seq}`,
  kind: "user_message",
  payload: { text: `m${seq}`, timestamp: null },
  created_at: "2026-10-26T20:00:00.000Z",
});

describe("mergeEvents", () => {
  it("appends events above the last seq in order", () => {
    expect(mergeEvents([event(1)], [event(3), event(2)]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns the same array when a page repeats", () => {
    const current = [event(1), event(2)];
    expect(mergeEvents(current, [event(1), event(2)])).toBe(current);
  });

  it("starts from empty", () => {
    expect(mergeEvents([], [event(1)]).map((e) => e.seq)).toEqual([1]);
  });
});

describe("patchAuthors", () => {
  const userMessage = (seq: number, author?: { author_user_id: string; author_name: string | null }): LiveSessionEvent => ({ ...event(seq), ...author });

  it("fills in the author of a message that had none", () => {
    const current = [userMessage(1), userMessage(2)];
    const patched = patchAuthors(current, [{ seq: 2, author_user_id: "u2", author_name: "Priya" }]);
    expect(patched[1]).toEqual({ ...event(2), author_user_id: "u2", author_name: "Priya" });
    expect(patched[0]).toBe(current[0]);
    expect(patched).not.toBe(current);
  });

  it("returns the same array when the authors already match", () => {
    const current = [userMessage(1, { author_user_id: "u2", author_name: "Priya" })];
    expect(patchAuthors(current, [{ seq: 1, author_user_id: "u2", author_name: "Priya" }])).toBe(current);
  });

  it("ignores events that are not user messages and seqs it does not hold", () => {
    const assistant: LiveSessionEvent = { ...event(3), kind: "assistant_text" };
    const current = [assistant, userMessage(4)];
    expect(patchAuthors(current, [{ seq: 3, author_user_id: "u2", author_name: "Priya" }, { seq: 9, author_user_id: "u2", author_name: "Priya" }])).toBe(current);
  });

  it("returns the same array when the page has no authors", () => {
    const current = [userMessage(1)];
    expect(patchAuthors(current, undefined)).toBe(current);
    expect(patchAuthors(current, [])).toBe(current);
  });
});
