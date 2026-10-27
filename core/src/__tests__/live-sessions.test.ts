import { describe, expect, it } from "bun:test";
import { HOST_FATAL_CODES, LIVE_SESSION_MODELS, deliveredText, isKnownModelAlias, isTestedClaudeVersion, normalizeInputText, parseClaudeVersion, presenceNames, splitAuthor } from "../live-sessions";

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

describe("Claude version check", () => {
  it("reads the version from `claude --version` output", () => {
    expect(parseClaudeVersion("2.1.311 (Claude Code)\n")).toBe("2.1.311");
    expect(parseClaudeVersion("no version")).toBeNull();
  });

  it("accepts the tested minor and warns for another one", () => {
    expect(isTestedClaudeVersion("2.1.311")).toBe(true);
    expect(isTestedClaudeVersion("2.1.0")).toBe(true);
    expect(isTestedClaudeVersion("2.2.0")).toBe(false);
    expect(isTestedClaudeVersion("1.9.4")).toBe(false);
    expect(isTestedClaudeVersion("3.1.0")).toBe(false);
  });

  it("says nothing when the version is not known", () => {
    expect(isTestedClaudeVersion(null)).toBeNull();
    expect(isTestedClaudeVersion("garbage")).toBeNull();
  });
});

describe("models", () => {
  it("lists Default first and accepts only listed aliases", () => {
    expect(LIVE_SESSION_MODELS[0]).toEqual({ alias: null, label: "Default" });
    expect(isKnownModelAlias(null)).toBe(true);
    expect(isKnownModelAlias(undefined)).toBe(true);
    expect(isKnownModelAlias("haiku")).toBe(true);
    expect(isKnownModelAlias("gpt-5; rm -rf /")).toBe(false);
  });
});

describe("presenceNames", () => {
  it("lists the other people once each, sorted, and never the viewer", () => {
    const state = { u1: [{ name: "Priya" }, { name: "Priya" }], u2: [{ name: "Dev" }], me: [{ name: "Maya" }] };
    expect(presenceNames(state, "me")).toEqual(["Dev", "Priya"]);
  });

  it("skips someone without a name", () => {
    expect(presenceNames({ u1: [{}], u2: [{ name: "  " }], u3: [{ name: "Sam" }] }, "me")).toEqual(["Sam"]);
    expect(presenceNames({}, "me")).toEqual([]);
  });
});
