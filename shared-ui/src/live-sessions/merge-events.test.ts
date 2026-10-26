import { describe, expect, it } from "bun:test";
import { mergeEvents } from "./merge-events";
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
