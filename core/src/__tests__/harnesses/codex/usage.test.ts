import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { codexRunner, codexUsageOfLine } from "../../../harnesses/codex/runner";

// A real `codex exec --json` run (codex-cli 0.171.0, prompt: reply with the word ok).
const lines = readFileSync(new URL("./exec-usage.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("codexUsageOfLine", () => {
  it("reads usage from turn.completed and takes cached tokens out of input", () => {
    const usages = lines.map(codexUsageOfLine).filter((usage) => usage !== null);
    expect(usages).toEqual([{ inputTokens: 22643 - 12288, outputTokens: 5, cacheReadTokens: 12288, cacheWriteTokens: 0, costUsd: null }]);
  });

  it("reports nothing for the other lines of the run", () => {
    expect(lines.filter((line) => !line.includes("turn.completed")).map(codexUsageOfLine)).toEqual([null, null, null]);
  });

  it("never goes below zero input, and reads missing cache fields as zero", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 12, output_tokens: 1 } });
    expect(codexUsageOfLine(line)).toEqual({ inputTokens: 0, outputTokens: 1, cacheReadTokens: 12, cacheWriteTokens: 0, costUsd: null });
    expect(codexUsageOfLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }))).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null });
  });

  it("reports nothing for a failed turn, a turn with no usage, or a partial line", () => {
    expect(codexUsageOfLine(JSON.stringify({ type: "turn.failed", error: { message: "x" } }))).toBeNull();
    expect(codexUsageOfLine(JSON.stringify({ type: "turn.completed" }))).toBeNull();
    expect(codexUsageOfLine('{"type":"turn.completed","usage":{"input_')).toBeNull();
  });

  it("is what the Codex runner side uses", () => {
    expect(codexRunner.usageOfLine(lines[3]!)?.cacheReadTokens).toBe(12288);
  });
});
