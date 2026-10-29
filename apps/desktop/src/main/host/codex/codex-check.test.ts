import { describe, expect, it } from "bun:test";
import { parseCodexAuth } from "./codex-check";

describe("parseCodexAuth", () => {
  it("reads signed in and signed out, and never guesses from other text", () => {
    expect(parseCodexAuth("Logged in using ChatGPT\n")).toBe("signed_in");
    expect(parseCodexAuth("Not logged in")).toBe("signed_out");
    expect(parseCodexAuth("")).toBe("unknown");
    expect(parseCodexAuth("error: unexpected argument")).toBe("unknown");
  });
});
