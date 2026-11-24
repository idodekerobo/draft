import { describe, expect, it } from "bun:test";
import { ADAPTERS } from "draft-core/harnesses";
import { eventsFor } from "draft-core/harnesses/claude/live-lines";
import { eventsForAdapter } from "../../ingestion/harness-lines";

const line = { stream: "root.jsonl", position: 0, raw: JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user", content: "hello" } }) };

describe("eventsForAdapter", () => {
  it("parses a Claude line with the Claude parser", () => {
    const events = eventsForAdapter("claude-terminal", line);
    expect(events).toEqual(eventsFor(line));
    expect(events[0]).toMatchObject({ kind: "user_message" });
  });

  it("fails for an adapter it does not know", () => {
    expect(() => eventsForAdapter("future", line)).toThrow("Unknown adapter");
  });

  it("maps every adapter in the registry", () => {
    for (const adapter of ADAPTERS) expect(() => eventsForAdapter(adapter.id, { stream: "x", position: 0, oversizeBytes: 1 })).not.toThrow();
  });

  it("notes a line that was too large to forward", () => {
    expect(eventsForAdapter("claude-terminal", { stream: "root.jsonl", position: 3, oversizeBytes: 9 })[0]).toMatchObject({ kind: "session_note" });
  });
});

describe("Codex lines", () => {
  const live = { stream: "thread", position: 0, raw: JSON.stringify({ method: "item/completed", params: { item: { type: "userMessage", id: "i1", content: [{ type: "text", text: "hi", text_elements: [] }] } } }) };
  const exec = { stream: "exec.jsonl", position: 0, raw: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }) };

  it("are parsed with the Codex parser for codex-app-server", () => {
    expect(eventsForAdapter("codex-app-server", live)[0]).toMatchObject({ kind: "user_message" });
  });

  it("use the exec parser for codex-exec only", () => {
    expect(eventsForAdapter("codex-exec", exec).map((e) => e.kind)).toEqual(["assistant_text"]);
    expect(eventsForAdapter("claude-print", line).map((e) => e.kind)).toEqual(["user_message"]);
  });
});
