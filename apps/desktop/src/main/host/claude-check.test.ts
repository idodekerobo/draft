import { describe, expect, it } from "bun:test";
import { parseClaudeAuth } from "./claude-check";

describe("parseClaudeAuth", () => {
  it("reads the signed in and signed out states", () => {
    expect(parseClaudeAuth('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe("signed_in");
    expect(parseClaudeAuth('{"loggedIn": false}')).toBe("signed_out");
  });

  it("does not block on output it cannot read", () => {
    expect(parseClaudeAuth("Not logged in")).toBe("unknown");
    expect(parseClaudeAuth("{}")).toBe("unknown");
    expect(parseClaudeAuth("")).toBe("unknown");
  });
});
