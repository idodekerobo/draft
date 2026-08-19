import { describe, expect, test } from "bun:test";
import { validateSummarizationResult } from "../../summarization/validate-result";

describe("validateSummarizationResult", () => {
  test("accepts a mix of ok and failed items", () => {
    const result = validateSummarizationResult({
      items: [
        {
          sessionId: "session-a",
          ok: true,
          payload: { who: "alice", project: "draft", outcome: "shipped", keyDecisions: ["used X"] },
        },
        { sessionId: "session-b", ok: false, error: { error: "claude_error" } },
      ],
    });
    expect(result).toEqual([
      {
        sessionId: "session-a",
        ok: true,
        payload: { who: "alice", project: "draft", outcome: "shipped", keyDecisions: ["used X"] },
      },
      { sessionId: "session-b", ok: false, error: { error: "claude_error" } },
    ]);
  });

  test("rejects a non-object envelope or a missing items array", () => {
    expect(() => validateSummarizationResult(null)).toThrow("items array");
    expect(() => validateSummarizationResult({})).toThrow("items array");
    expect(() => validateSummarizationResult([])).toThrow("items array");
  });

  test("rejects an ok item with a malformed payload", () => {
    expect(() =>
      validateSummarizationResult({ items: [{ sessionId: "s", ok: true, payload: { who: "a" } }] }),
    ).toThrow('"project"');
  });

  test("rejects duplicate sessionIds", () => {
    expect(() =>
      validateSummarizationResult({
        items: [
          { sessionId: "s", ok: false, error: {} },
          { sessionId: "s", ok: false, error: {} },
        ],
      }),
    ).toThrow("duplicate sessionId");
  });
});
