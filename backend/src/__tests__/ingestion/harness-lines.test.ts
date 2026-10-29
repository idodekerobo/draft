import { describe, expect, it } from "bun:test";
import { eventsFor } from "../../ingestion/claude-code/live-lines";
import { eventsForHarness } from "../../ingestion/harness-lines";

const line = { file: "root.jsonl", offset: 0, raw: JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user", content: "hello" } }) };

describe("eventsForHarness", () => {
  it("parses a Claude line with the Claude parser", () => {
    const events = eventsForHarness("claude", line);
    expect(events).toEqual(eventsFor(line));
    expect(events[0]).toMatchObject({ kind: "user_message" });
  });

  it("falls back to the Claude parser for a harness it does not know", () => {
    expect(eventsForHarness("future", line)).toEqual(eventsFor(line));
  });

  it("notes a line that was too large to forward", () => {
    expect(eventsForHarness("claude", { file: "root.jsonl", offset: 3, oversizeBytes: 9 })[0]).toMatchObject({ kind: "session_note" });
  });
});
