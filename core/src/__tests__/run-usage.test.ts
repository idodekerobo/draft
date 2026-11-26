import { describe, expect, it } from "bun:test";
import { parseRunUsage, sumRunUsage } from "../run-usage";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.25 };

describe("parseRunUsage", () => {
  it("accepts a full usage value, with or without a cost", () => {
    expect(parseRunUsage(usage)).toEqual(usage);
    expect(parseRunUsage({ ...usage, costUsd: null })).toEqual({ ...usage, costUsd: null });
  });

  it("drops fields it does not know", () => {
    expect(parseRunUsage({ ...usage, extra: "x" })).toEqual(usage);
  });

  it("returns null for anything that is not a full valid value", () => {
    for (const bad of [
      null,
      undefined,
      "usage",
      [],
      {},
      { ...usage, inputTokens: -1 },
      { ...usage, outputTokens: 1.5 },
      { ...usage, cacheReadTokens: "2" },
      { ...usage, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 2 },
      { ...usage, costUsd: -0.1 },
      { ...usage, costUsd: Number.NaN },
      { ...usage, costUsd: "0.25" },
      { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
    ]) {
      expect(parseRunUsage(bad)).toBeNull();
    }
  });
});

describe("sumRunUsage", () => {
  it("adds tokens and costs", () => {
    expect(sumRunUsage([usage, usage])).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2, costUsd: 0.5 });
  });

  it("has no cost when any part has none", () => {
    expect(sumRunUsage([usage, { ...usage, costUsd: null }]).costUsd).toBeNull();
  });

  it("is zero for no parts", () => {
    expect(sumRunUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  });
});
