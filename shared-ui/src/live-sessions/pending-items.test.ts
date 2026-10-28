import { describe, expect, it } from "bun:test";
import { pendingItems } from "./pending-items";
import type { ComposerInput, LiveSessionEvent } from "./types";

const context = { viewerName: "Priya", ownerName: "Maya", hostOffline: false };
const NOW = Date.parse("2026-10-27T12:00:00Z");
const input = (patch: Partial<ComposerInput>): ComposerInput => ({
  id: "i1", author_user_id: "u1", author_name: "Priya", text: "run the tests", state: "queued", reason: null,
  created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), mine: true, ...patch,
});
const turn = (seq: number, text: string, at = NOW + 2_000): LiveSessionEvent => ({ seq, source_id: `s${seq}`, kind: "user_message", payload: { text }, created_at: new Date(at).toISOString() });

describe("pendingItems", () => {
  it("shows sending, queued and delivering messages, and leaves failed ones to the message box", () => {
    const items = pendingItems([input({ id: "a", state: "sending" }), input({ id: "b" }), input({ id: "c", state: "delivering" }), input({ id: "d", state: "failed" }), input({ id: "e", state: "uncertain" })], [], context);
    expect(items.map((item) => item.input.id)).toEqual(["a", "b", "c"]);
  });

  it("labels your own message with your name and a teammate's with theirs", () => {
    const items = pendingItems([input({ author_name: "You" }), input({ id: "i2", mine: false, author_name: "Dev" })], [], context);
    expect(items.map((item) => item.author)).toEqual(["Priya", "Dev"]);
  });

  it("uses the key that follows a message from the local send to the server copy", () => {
    expect(pendingItems([input({ key: "local-1" })], [], context)[0]!.key).toBe("local-1");
    expect(pendingItems([input({})], [], context)[0]!.key).toBe("i1");
  });

  it("leaves out a message that the log already holds, once per event", () => {
    const events = [turn(1, "[Priya via Draft] run the tests")];
    expect(pendingItems([input({})], events, context)).toEqual([]);
    expect(pendingItems([input({}), input({ id: "i2" })], events, context).map((item) => item.input.id)).toEqual(["i2"]);
  });

  it("keeps a message when the same words were in the log long before it", () => {
    const old = turn(1, "run the tests", NOW - 10 * 60_000);
    expect(pendingItems([input({})], [old], context).length).toBe(1);
  });
});
