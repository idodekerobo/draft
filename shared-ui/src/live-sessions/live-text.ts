import { LIVE_TEXT_EVENT, isLiveTextChunk, type LiveTextChunk } from "draft-core/live-sessions";

/** Passes the live text chunks of a signal to `onChunk`. Other events and payloads are dropped. */
export function liveTextListener(onChunk: (chunk: LiveTextChunk) => void) {
  return (event: string, payload?: unknown) => {
    if (event === LIVE_TEXT_EVENT && isLiveTextChunk(payload)) onChunk(payload);
  };
}
