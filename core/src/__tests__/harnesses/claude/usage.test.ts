import { describe, expect, it } from "bun:test";
import { claudeRunner, claudeUsageOfLine } from "../../../harnesses/claude/runner";

// The shape of a real `claude -p --output-format stream-json` result line, with the text fields left out.
const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 22,
  total_cost_usd: 1.1521896,
  usage: {
    input_tokens: 7,
    output_tokens: 42782,
    cache_read_input_tokens: 105602,
    cache_creation_input_tokens: 79793,
    cache_creation: { ephemeral_1h_input_tokens: 79793, ephemeral_5m_input_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
  },
});

describe("claudeUsageOfLine", () => {
  it("reads tokens and cost from the result line", () => {
    expect(claudeUsageOfLine(resultLine)).toEqual({ inputTokens: 7, outputTokens: 42782, cacheReadTokens: 105602, cacheWriteTokens: 79793, costUsd: 1.1521896 });
  });

  it("has no cost when the line gives none, and no cache when the fields are missing", () => {
    const line = JSON.stringify({ type: "result", usage: { input_tokens: 3, output_tokens: 4 } });
    expect(claudeUsageOfLine(line)).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null });
  });

  it("reports nothing for other lines, a result with no usage, or a partial line", () => {
    expect(claudeUsageOfLine(JSON.stringify({ type: "assistant", message: {} }))).toBeNull();
    expect(claudeUsageOfLine(JSON.stringify({ type: "result", is_error: true }))).toBeNull();
    expect(claudeUsageOfLine(JSON.stringify({ type: "result", usage: { input_tokens: "many" } }))).toBeNull();
    expect(claudeUsageOfLine('{"type":"result","usage":{"input_tok')).toBeNull();
  });

  it("is what the Claude runner side uses", () => {
    expect(claudeRunner.usageOfLine(resultLine)?.outputTokens).toBe(42782);
  });
});
