import { LIVE_TEXT_EVENT, isLiveTextChunk, type LiveTextChunk } from "draft-core/live-sessions";
import type { LiveSessionEvent } from "./types";

export interface LivePreview {
  messageId: string;
  text: string;
  final: boolean;
  /** Stored events up to this seq came before the message began, so they cannot be its stored copy. */
  startedAfterSeq: number;
  lastChunkAt: number;
}

export interface LiveTextState {
  previews: LivePreview[];
  /** The pieces received for each message, by index. */
  parts: Record<string, string[]>;
}

export const emptyLiveText: LiveTextState = { previews: [], parts: {} };

export const PREVIEW_EXPIRY_MS = 60_000;
const MAX_PREVIEWS = 10;
const MAX_CHUNK_INDEX = 100_000;

/** Passes the live text chunks of a signal to `onChunk`. Other events and payloads are dropped. */
export function liveTextListener(onChunk: (chunk: LiveTextChunk) => void) {
  return (event: string, payload?: unknown) => {
    if (event === LIVE_TEXT_EVENT && isLiveTextChunk(payload)) onChunk(payload);
  };
}

/** The pieces joined in order, up to the first missing one. */
function textUpTo(parts: string[]): string {
  let text = "";
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === undefined) break;
    text += parts[i];
  }
  return text;
}

/** Keeps the pieces of the previews that are still listed, so a dropped preview leaves nothing behind. */
function withPreviews(previews: LivePreview[], parts: Record<string, string[]>): LiveTextState {
  const kept: Record<string, string[]> = {};
  for (const preview of previews) {
    if (parts[preview.messageId]) kept[preview.messageId] = parts[preview.messageId]!;
  }
  return { previews, parts: kept };
}

/** Adds a chunk. `lastSeq` is the highest stored event seq the viewer has right now. */
export function addChunk(state: LiveTextState, chunk: LiveTextChunk, lastSeq: number, now: number): LiveTextState {
  if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > MAX_CHUNK_INDEX) return state;
  const parts = [...(state.parts[chunk.messageId] ?? [])];
  parts[chunk.index] = chunk.text;
  const current = state.previews.find((p) => p.messageId === chunk.messageId);
  const preview: LivePreview = {
    messageId: chunk.messageId,
    text: textUpTo(parts),
    final: current?.final === true || chunk.final,
    startedAfterSeq: current?.startedAfterSeq ?? lastSeq,
    lastChunkAt: now,
  };
  const previews = current
    ? state.previews.map((p) => (p === current ? preview : p))
    : [...state.previews, preview].slice(-MAX_PREVIEWS);
  return withPreviews(previews, { ...state.parts, [chunk.messageId]: parts });
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function sameText(preview: string, stored: string): boolean {
  const a = normalize(preview);
  const b = normalize(stored);
  return a === b || (a !== "" && b.startsWith(a)) || (b !== "" && a.startsWith(b));
}

/**
 * Drops previews that a stored message has replaced, and expired ones. It runs over all the events each time,
 * so a stored message that already removed a preview must not remove another one: each match raises the
 * remaining previews' `startedAfterSeq` past that message.
 */
export function reconcile(state: LiveTextState, events: LiveSessionEvent[], now: number): LiveTextState {
  let lastUserSeq = 0;
  for (const event of events) {
    if (event.kind === "user_message" && !event.payload.agent_id && event.seq > lastUserSeq) lastUserSeq = event.seq;
  }
  let previews = state.previews.filter((p) => now - p.lastChunkAt <= PREVIEW_EXPIRY_MS && !(p.final && lastUserSeq > p.startedAfterSeq));

  for (const event of events) {
    if (event.kind !== "assistant_text" || event.payload.agent_id) continue;
    const seq = event.seq;
    const stored = event.payload.text ?? "";
    let index = previews.findIndex((p) => p.startedAfterSeq < seq && sameText(p.text, stored));
    if (index < 0) index = previews.findIndex((p) => p.final && p.startedAfterSeq < seq);
    if (index < 0) continue;
    previews = previews
      .filter((_, i) => i !== index)
      .map((p) => (p.startedAfterSeq < seq ? { ...p, startedAfterSeq: seq } : p));
  }

  const unchanged = previews.length === state.previews.length && previews.every((p, i) => p === state.previews[i]);
  return unchanged ? state : withPreviews(previews, state.parts);
}
