// Ported from flooently-brain/backend/src/ingest/claude-code.test.ts.

import { describe, expect, test } from "bun:test";
import { parseClaudeCodeJsonl } from "../../../ingestion/claude-code/parse-transcript";

describe("parseClaudeCodeJsonl", () => {
  test("parses string user turns and assistant text blocks", () => {
    const parsed = parseClaudeCodeJsonl(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-10T10:00:00.000Z",
          message: { role: "user", content: " hello " },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T10:01:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: " hi " }] },
        }),
      ].join("\n"),
    );

    expect(parsed).toEqual({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      startedAt: "2026-07-10T10:00:00.000Z",
      endedAt: "2026-07-10T10:01:00.000Z",
    });
  });

  test("parses user block arrays and excludes sidechain turns", () => {
    const parsed = parseClaudeCodeJsonl(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-10T10:00:00.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "first" },
              { type: "tool_result", text: "ignored" },
              { type: "text", text: "second" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T10:01:00.000Z",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "skip me" }] },
        }),
      ].join("\n"),
    );

    expect(parsed.messages).toEqual([{ role: "user", content: "first\nsecond" }]);
    expect(parsed.endedAt).toBe("2026-07-10T10:01:00.000Z");
  });

  test("skips malformed lines and timestamp-less header lines", () => {
    const parsed = parseClaudeCodeJsonl(
      [
        JSON.stringify({ type: "last-prompt", prompt: "no timestamp" }),
        "{not json",
        JSON.stringify({ type: "mode" }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T10:02:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", text: "hidden" }, { type: "text", text: "visible" }],
          },
        }),
      ].join("\n"),
    );

    expect(parsed.messages).toEqual([{ role: "assistant", content: "visible" }]);
    expect(parsed.startedAt).toBe("2026-07-10T10:02:00.000Z");
    expect(parsed.endedAt).toBe("2026-07-10T10:02:00.000Z");
  });

  test("returns null bounds and no messages for empty input", () => {
    expect(parseClaudeCodeJsonl("")).toEqual({ messages: [], startedAt: null, endedAt: null });
  });
});
