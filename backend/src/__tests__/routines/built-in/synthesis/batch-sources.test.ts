import { describe, expect, it } from "bun:test";
import { batchSources, estimateTokens } from "../../../../routines/built-in/synthesis/batch-sources";

const source = (id: string, chars: number) => ({ id, version: "v1", contentHash: "a".repeat(64), chars });
const ids = (batches: Array<Array<{ id: string }>>) => batches.map((batch) => batch.map((item) => item.id));

describe("batchSources", () => {
  it("makes no batch for no sources", () => {
    expect(batchSources([], 1_000)).toEqual([]);
  });

  it("keeps everything in one batch while it fits", () => {
    expect(ids(batchSources([source("a", 400), source("b", 400)], 1_000))).toEqual([["a", "b"]]);
  });

  it("starts a new batch when the next source would pass the budget, and keeps the order", () => {
    // 1,000 tokens is 4,000 characters. Each source here is 600 tokens, so two do not fit together.
    expect(ids(batchSources([source("a", 2_400), source("b", 2_400), source("c", 2_400)], 1_000))).toEqual([["a"], ["b"], ["c"]]);
    expect(ids(batchSources([source("a", 1_200), source("b", 1_200), source("c", 1_200), source("d", 1_200)], 1_000))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("gives a source bigger than the budget a batch of its own", () => {
    expect(ids(batchSources([source("a", 400), source("huge", 400_000), source("b", 400)], 1_000))).toEqual([["a"], ["huge"], ["b"]]);
  });

  it("fills a batch up to the budget exactly", () => {
    expect(ids(batchSources([source("a", 2_000), source("b", 2_000), source("c", 4)], 1_000))).toEqual([["a", "b"], ["c"]]);
  });

  it("rounds a token estimate up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});
