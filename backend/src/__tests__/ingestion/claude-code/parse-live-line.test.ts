import { describe, expect, it } from "bun:test";
import { parseLiveLine } from "../../../ingestion/claude-code/parse-live-line";

function line(record: Record<string, unknown>, offset = 0) {
  return parseLiveLine({ file: "root.jsonl", offset, raw: JSON.stringify(record) });
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: "u-1",
  timestamp: "2026-10-26T20:00:00.000Z",
  message: { role: "user", content },
  ...extra,
});

describe("parseLiveLine", () => {
  it("maps a typed user turn", () => {
    expect(line(user("Run ls in this folder"))).toEqual({
      sourceId: "u-1",
      kind: "user_message",
      payload: { text: "Run ls in this folder", timestamp: "2026-10-26T20:00:00.000Z" },
    });
  });

  it("joins the text blocks of an assistant line and drops thinking and tool_use", () => {
    const event = line({
      type: "assistant",
      uuid: "a-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "First" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
          { type: "text", text: "Second" },
        ],
      },
    });
    expect(event?.kind).toBe("assistant_text");
    expect(event?.payload.text).toBe("First\nSecond");
  });

  it("skips tool results, which Claude Code writes as user lines", () => {
    expect(line(user([{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }]))).toBeNull();
  });

  it("skips lines that are not user or assistant turns", () => {
    for (const type of ["attachment", "api-request", "ai-title", "system", "permission-mode"]) {
      expect(line({ type, uuid: "x", message: { role: "user", content: "text" } })).toBeNull();
    }
  });

  it("skips sub-agent, meta and compact summary lines", () => {
    expect(line(user("x", { isSidechain: true }))).toBeNull();
    expect(line(user("x", { isMeta: true }))).toBeNull();
    expect(line(user("This session is being continued from a previous conversation", { isCompactSummary: true }))).toBeNull();
  });

  it("skips text Claude Code writes for its own bookkeeping", () => {
    for (const text of [
      "<task-notification>\n<task-id>a1</task-id>\n</task-notification>",
      "<command-name>/compact</command-name>",
      "<local-command-stdout>Compacted</local-command-stdout>",
      "<system-reminder>note</system-reminder>",
    ]) {
      expect(line(user(text))).toBeNull();
    }
  });

  it("keeps a typed slash command", () => {
    expect(line(user("/compact"))?.payload.text).toBe("/compact");
  });

  it("uses the native uuid as source id, else file and offset", () => {
    expect(line(user("hi"), 7)?.sourceId).toBe("u-1");
    expect(line(user("hi", { uuid: undefined }), 7)?.sourceId).toBe("root.jsonl:7");
  });

  it("ignores a truncated line", () => {
    expect(parseLiveLine({ file: "root.jsonl", offset: 0, raw: '{"type":"us' })).toBeNull();
  });
});
