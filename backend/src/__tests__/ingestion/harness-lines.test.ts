import { describe, expect, it } from "bun:test";
import { eventsFor } from "draft-core/harnesses/claude/live-lines";
import { eventsForHarness, routineEventsForHarness } from "../../ingestion/harness-lines";

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

describe("Codex lines", () => {
  const live = { file: "thread", offset: 0, raw: JSON.stringify({ method: "item/completed", params: { item: { type: "userMessage", id: "i1", content: [{ type: "text", text: "hi", text_elements: [] }] } } }) };
  const exec = { file: "exec.jsonl", offset: 0, raw: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }) };

  it("are parsed with the Codex parser when the session's harness is Codex", () => {
    expect(eventsForHarness("codex", live)[0]).toMatchObject({ kind: "user_message" });
  });

  it("use the exec parser for a routine run of Codex only", () => {
    expect(routineEventsForHarness("codex", exec).map((e) => e.kind)).toEqual(["assistant_text"]);
    expect(routineEventsForHarness("claude", line).map((e) => e.kind)).toEqual(["user_message"]);
  });
});
