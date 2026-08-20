import { describe, expect, test } from "bun:test";
import { truncateTranscriptFromFront } from "../../summarization/render-transcript";

describe("truncateTranscriptFromFront", () => {
  test("leaves short transcripts untouched", () => {
    expect(truncateTranscriptFromFront("short", 100)).toBe("short");
  });

  test("truncates from the front and marks how much was removed", () => {
    const rendered = "0123456789";
    const result = truncateTranscriptFromFront(rendered, 4);
    expect(result).toBe("[truncated 6 chars]\n\n6789");
    expect(result.endsWith("6789")).toBe(true);
  });
});
