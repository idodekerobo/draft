import { describe, expect, it } from "bun:test";
import { liveTextListener } from "./live-text";

describe("liveTextListener", () => {
  it("passes a live text chunk to onChunk", () => {
    const seen: unknown[] = [];
    const chunk = { messageId: "m1", index: 0, text: "Hi", final: false };
    liveTextListener((c) => seen.push(c))("text", chunk);
    expect(seen).toEqual([chunk]);
  });

  it("drops another event name and a payload that is not a chunk", () => {
    const seen: unknown[] = [];
    const listener = liveTextListener((c) => seen.push(c));
    listener("events", { messageId: "m1", index: 0, text: "Hi", final: false });
    listener("text", { messageId: "", index: 0, text: "Hi", final: false });
    listener("text", undefined);
    listener("catch-up");
    expect(seen).toEqual([]);
  });
});
