import { describe, expect, it } from "bun:test";
import { HOST_FATAL_CODES, deliveredText, normalizeInputText, splitAuthor } from "../live-sessions";

describe("author tag", () => {
  it("round-trips through deliveredText and splitAuthor", () => {
    expect(splitAuthor(deliveredText("Priya", "run the tests"))).toEqual({ text: "run the tests", author: "Priya" });
  });

  it("leaves a typed prompt alone", () => {
    expect(splitAuthor("fix the login bug")).toEqual({ text: "fix the login bug", author: null });
  });

  it("cleans a name that could break the tag", () => {
    expect(deliveredText("A]\u001b[B", "hi")).toBe("[A B via Draft] hi");
    expect(deliveredText("   ", "hi")).toBe("[A teammate via Draft] hi");
    expect(deliveredText("x".repeat(100), "hi")).toBe(`[${"x".repeat(60)} via Draft] hi`);
  });

  it("drops whitespace after the tag", () => {
    expect(splitAuthor("[Dev via Draft]   hello").text).toBe("hello");
  });
});

describe("normalizeInputText", () => {
  it("keeps line breaks and tabs, and removes characters that could end a paste early", () => {
    expect(normalizeInputText("a\u001b[201~ ls\u0000\r\nb\tc")).toBe("a[201~ ls\nb\tc");
  });
});

describe("HOST_FATAL_CODES", () => {
  it("stops a host for an ended or foreign session and not for a full queue", () => {
    expect(HOST_FATAL_CODES.has("session_ended")).toBe(true);
    expect(HOST_FATAL_CODES.has("queue_full")).toBe(false);
  });
});
