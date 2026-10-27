import { describe, expect, it } from "bun:test";
import { buildStreamItems, toolSummary } from "./stream-items";
import type { LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

let seq = 0;
const event = (kind: LiveSessionEventKind, payload: LiveSessionEventPayload): LiveSessionEvent => ({
  seq: ++seq,
  source_id: `s${seq}`,
  kind,
  payload,
  created_at: "2026-10-26T20:00:00.000Z",
});

describe("buildStreamItems", () => {
  it("pairs a tool result with its tool call by id", () => {
    const items = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Bash", input: { command: "ls -la" } }),
      event("assistant_text", { text: "Looking" }),
      event("tool_result", { tool_use_id: "t1", content: "a.txt", is_error: false }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["tool", "assistant"]);
    expect(items[0]).toMatchObject({ name: "Bash", summary: "ls -la", result: { text: "a.txt", isError: false, truncated: false } });
  });

  it("leaves the result empty until it arrives, and ignores a result with no call", () => {
    const items = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }),
      event("tool_result", { tool_use_id: "nope", content: "x" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "tool", result: null });
  });

  it("keeps the order of turns, thinking and notes", () => {
    const items = buildStreamItems([
      event("user_message", { text: "hi" }),
      event("thinking", { text: "hmm" }),
      event("assistant_text", { text: "hello" }),
      event("session_note", { text: "Conversation compacted" }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["user", "thinking", "assistant", "note"]);
  });

  it("carries the sub-agent id", () => {
    const [item] = buildStreamItems([event("assistant_text", { text: "listing", agent_id: "a1" })]);
    expect(item).toMatchObject({ type: "assistant", agentId: "a1" });
  });

  it("marks failed and clipped results", () => {
    const [tool] = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Bash", input: {} }),
      event("tool_result", { tool_use_id: "t1", content: "boom", is_error: true, truncated: true }),
    ]);
    expect(tool).toMatchObject({ result: { isError: true, truncated: true } });
  });
});

describe("toolSummary", () => {
  it("prefers the field that says what the tool acts on", () => {
    expect(toolSummary({ command: "bun test", description: "Run tests" })).toBe("bun test");
    expect(toolSummary({ file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(toolSummary({ pattern: "TODO" })).toBe("TODO");
  });

  it("falls back to the first string, and handles clipped or empty input", () => {
    expect(toolSummary({ thing: "value" })).toBe("value");
    expect(toolSummary("raw text\nsecond")).toBe("raw text");
    expect(toolSummary({})).toBe("");
    expect(toolSummary(undefined)).toBe("");
  });

  it("keeps the first line and clips it", () => {
    expect(toolSummary({ command: "echo one\necho two" })).toBe("echo one");
    expect(toolSummary({ command: "x".repeat(300) })).toHaveLength(101);
  });
});

describe("messages sent through Draft", () => {
  it("shows the author and removes the prefix from the text", () => {
    const items = buildStreamItems([
      { seq: 1, source_id: "a", kind: "user_message", payload: { text: "[Priya via Draft] please add tests\nthanks" }, created_at: "" },
      { seq: 2, source_id: "b", kind: "user_message", payload: { text: "[not a prefix] hi" }, created_at: "" },
    ]);
    expect(items[0]).toMatchObject({ type: "user", author: "Priya", text: "please add tests\nthanks" });
    expect(items[1]).toMatchObject({ type: "user", author: null, text: "[not a prefix] hi" });
  });
});
