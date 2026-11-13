import { describe, expect, it } from "bun:test";
import type { LiveTextChunk } from "draft-core/live-sessions";
import { PREVIEW_EXPIRY_MS, addChunk, emptyLiveText, liveTextListener, reconcile, type LiveTextState } from "./live-text";
import type { LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

const chunk = (messageId: string, index: number, text: string, final = false): LiveTextChunk => ({ messageId, index, text, final });
const stored = (seq: number, kind: LiveSessionEventKind, payload: LiveSessionEventPayload): LiveSessionEvent => ({
  seq,
  source_id: `s${seq}`,
  kind,
  payload,
  created_at: "",
});
const storedText = (seq: number, text: string, extra: LiveSessionEventPayload = {}) => stored(seq, "assistant_text", { text, ...extra });
const T0 = 1_000_000;

describe("liveTextListener", () => {
  it("passes a live text chunk to onChunk", () => {
    const seen: unknown[] = [];
    const piece = chunk("m1", 0, "Hi");
    liveTextListener((c) => seen.push(c))("text", piece);
    expect(seen).toEqual([piece]);
  });

  it("drops another event name and a payload that is not a chunk", () => {
    const seen: unknown[] = [];
    const listener = liveTextListener((c) => seen.push(c));
    listener("events", chunk("m1", 0, "Hi"));
    listener("text", { messageId: "", index: 0, text: "Hi", final: false });
    listener("text", undefined);
    listener("catch-up");
    expect(seen).toEqual([]);
  });
});

describe("addChunk", () => {
  it("joins chunks in index order", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "Hel"), 4, T0);
    state = addChunk(state, chunk("m1", 1, "lo"), 4, T0);
    expect(state.previews).toEqual([{ messageId: "m1", text: "Hello", final: false, startedAfterSeq: 4, lastChunkAt: T0 }]);
  });

  it("treats a repeated index as the same piece", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "Hel"), 0, T0);
    state = addChunk(state, chunk("m1", 0, "Hel"), 0, T0 + 1);
    expect(state.previews[0]!.text).toBe("Hel");
    expect(state.parts.m1).toEqual(["Hel"]);
  });

  it("shows only the text before a gap, then the rest once the gap is filled", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "A"), 0, T0);
    state = addChunk(state, chunk("m1", 2, "C"), 0, T0);
    expect(state.previews[0]!.text).toBe("A");
    state = addChunk(state, chunk("m1", 1, "B"), 0, T0);
    expect(state.previews[0]!.text).toBe("ABC");
  });

  it("keeps final once it is set", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "A", true), 0, T0);
    state = addChunk(state, chunk("m1", 1, "B", false), 0, T0);
    expect(state.previews[0]!.final).toBe(true);
  });

  it("appends a new message at the end and records the seq it started after", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "A"), 3, T0);
    state = addChunk(state, chunk("m2", 0, "B"), 5, T0);
    expect(state.previews.map((p) => [p.messageId, p.startedAfterSeq])).toEqual([["m1", 3], ["m2", 5]]);
  });

  it("ignores an index that is negative or above 100000", () => {
    expect(addChunk(emptyLiveText, chunk("m1", -1, "A"), 0, T0)).toBe(emptyLiveText);
    expect(addChunk(emptyLiveText, chunk("m1", 100_001, "A"), 0, T0)).toBe(emptyLiveText);
  });

  it("keeps at most 10 previews and drops the oldest", () => {
    let state: LiveTextState = emptyLiveText;
    for (let i = 0; i < 11; i++) state = addChunk(state, chunk(`m${i}`, 0, "x"), 0, T0);
    expect(state.previews.length).toBe(10);
    expect(state.previews[0]!.messageId).toBe("m1");
    expect(state.parts.m0).toBeUndefined();
  });
});

describe("reconcile", () => {
  const withPreview = (text: string, opts: { final?: boolean; startedAfterSeq?: number; at?: number } = {}) =>
    addChunk(emptyLiveText, chunk("m1", 0, text, opts.final ?? false), opts.startedAfterSeq ?? 0, opts.at ?? T0);

  it("removes a preview whose text equals a stored message", () => {
    const state = withPreview("Hello there");
    const next = reconcile(state, [storedText(1, "Hello there")], T0);
    expect(next.previews).toEqual([]);
    expect(next.parts).toEqual({});
  });

  it("removes a preview when the stored text starts with it", () => {
    const next = reconcile(withPreview("Hello"), [storedText(1, "Hello there, friend")], T0);
    expect(next.previews).toEqual([]);
  });

  it("compares with whitespace collapsed and trimmed", () => {
    const next = reconcile(withPreview("  Hello   there "), [storedText(1, "Hello\nthere")], T0);
    expect(next.previews).toEqual([]);
  });

  it("removes only the oldest final preview when a stored message does not match", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "First draft", true), 0, T0);
    state = addChunk(state, chunk("m2", 0, "Second draft", true), 0, T0);
    const next = reconcile(state, [storedText(1, "Something else")], T0);
    expect(next.previews.map((p) => p.messageId)).toEqual(["m2"]);
  });

  it("keeps a preview that is not final when a stored message does not match", () => {
    const state = withPreview("Still writing");
    const next = reconcile(state, [storedText(1, "Something else")], T0);
    expect(next).toBe(state);
  });

  it("ignores a stored message written before the preview began", () => {
    const state = withPreview("Hello", { startedAfterSeq: 5 });
    expect(reconcile(state, [storedText(5, "Hello")], T0)).toBe(state);
  });

  it("expires a preview after 60 seconds without a chunk", () => {
    const state = withPreview("Hello");
    expect(reconcile(state, [], T0 + PREVIEW_EXPIRY_MS).previews.length).toBe(1);
    expect(reconcile(state, [], T0 + PREVIEW_EXPIRY_MS + 1).previews).toEqual([]);
  });

  it("reconciles two messages in a row one by one", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "One"), 0, T0);
    state = addChunk(state, chunk("m2", 0, "Two"), 0, T0);
    const next = reconcile(state, [storedText(1, "One"), storedText(2, "Two")], T0);
    expect(next.previews).toEqual([]);
  });

  it("does not let one stored message remove two previews with the same text", () => {
    let state = addChunk(emptyLiveText, chunk("m1", 0, "Same"), 0, T0);
    state = addChunk(state, chunk("m2", 0, "Same"), 0, T0);
    const once = reconcile(state, [storedText(1, "Same")], T0);
    expect(once.previews.map((p) => p.messageId)).toEqual(["m2"]);
    expect(reconcile(once, [storedText(1, "Same")], T0)).toBe(once);
  });

  it("ignores a sub-agent's stored text", () => {
    const state = withPreview("Hello");
    expect(reconcile(state, [storedText(1, "Hello", { agent_id: "a1" })], T0)).toBe(state);
  });

  it("removes a preview for a stored lead-in event with matching text", () => {
    const next = reconcile(withPreview("Let me check"), [storedText(1, "Let me check", { preview: true })], T0);
    expect(next.previews).toEqual([]);
  });

  it("drops final previews when a new user message is stored after them", () => {
    const state = addChunk(emptyLiveText, chunk("m1", 0, "Done", true), 2, T0);
    const next = reconcile(state, [stored(3, "user_message", { text: "next" })], T0);
    expect(next.previews).toEqual([]);
  });

  it("keeps a sub-agent's user message from ending a turn", () => {
    const state = addChunk(emptyLiveText, chunk("m1", 0, "Done", true), 2, T0);
    expect(reconcile(state, [stored(3, "user_message", { text: "x", agent_id: "a1" })], T0)).toBe(state);
  });

  it("returns the same state object when nothing changed", () => {
    const state = withPreview("Hello");
    expect(reconcile(state, [], T0)).toBe(state);
    expect(reconcile(state, [storedText(1, "Other text")], T0)).toBe(state);
  });
});
