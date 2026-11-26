import { describe, expect, it } from "bun:test";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { ASK_TOOL, INPUT_ENTRY_KIND, normalizeWrites } from "../../embedded-agent/pi/normalize";

const entry = (value: object) => ({ type: "entry", value }) as unknown as StorageWrite;
const submission = (value: object) => ({ type: "submission", value }) as unknown as StorageWrite;
const rows = (writes: StorageWrite[]) => normalizeWrites(writes, () => "T").map((row) => [row.sourceId, (row.payload as { body: object }).body]);

describe("normalizing pi's writes into Draft's events", () => {
  it("reads a person's message with its request id and author from the entry's data", () => {
    expect(rows([entry({ id: 5, conversationId: 1, kind: INPUT_ENTRY_KIND, data: { requestId: "in-1", text: "hello", authorUserId: "u1" } })])).toEqual([
      ["req:in-1", { kind: "user_message", requestId: "in-1", text: "hello", authorUserId: "u1" }],
    ]);
  });

  it("splits an answer into text, thinking and tool use, each under its own source id", () => {
    const out = rows([entry({ id: 7, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model: "claude-test", content: [
      { type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "t1", name: "context_read", arguments: { path: "a" } },
    ] }] })]);
    expect(out).toEqual([
      ["entry:7:0", { kind: "thinking", text: "hm" }],
      ["entry:7:1", { kind: "assistant_text", text: "Looking.", model: { provider: "anthropic", model: "claude-test" } }],
      ["entry:7:2", { kind: "tool_use", toolCallId: "t1", name: "context_read", input: { path: "a" } }],
    ]);
  });

  it("reads a tool result, and leaves out the question tool, which is shown as a question card", () => {
    expect(rows([entry({ id: 8, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "t1", toolName: "context_read", content: [{ type: "text", text: "ok" }], isError: false }] })])).toEqual([
      ["entry:8", { kind: "tool_result", toolCallId: "t1", content: "ok", isError: false }],
    ]);
    expect(rows([
      entry({ id: 9, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "q1", name: ASK_TOOL, arguments: {} }] }] }),
      entry({ id: 10, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "q1", toolName: ASK_TOOL, content: [], isError: false }] }),
    ])).toEqual([]);
  });

  it("settles a turn when its input is answered, and says why when it is not", () => {
    expect(rows([submission({ id: 3, type: "input", status: "done", requestId: "in-1" })])).toEqual([["settled:3", { kind: "turn_settled", requestId: "in-1", outcome: "completed" }]]);
    expect(rows([submission({ id: 4, type: "input", status: "unanswered", requestId: "in-2", reason: "aborted" })])).toEqual([["settled:4", { kind: "turn_settled", requestId: "in-2", outcome: "interrupted" }]]);
    expect(rows([submission({ id: 5, type: "input", status: "unanswered", requestId: "in-3", reason: "model_error" })])).toEqual([["settled:5", { kind: "turn_settled", requestId: "in-3", outcome: "failed", reason: "model_error" }]]);
  });

  it("ignores writes that are not part of the conversation Draft shows, and unfinished submissions", () => {
    expect(rows([submission({ id: 6, type: "input", status: "queued", requestId: "x" }), submission({ id: 7, type: "write", status: "done" }), entry({ id: 11, conversationId: 1, kind: "pi.system" })])).toEqual([]);
  });
});
