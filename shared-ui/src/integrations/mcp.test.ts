import { describe, expect, test } from "bun:test";
import { mcpSetupSnippets, mcpUrl } from "./mcp";

describe("mcpUrl", () => {
  test("appends /mcp and ignores trailing slashes", () => {
    expect(mcpUrl("https://api.draftai.us")).toBe("https://api.draftai.us/mcp");
    expect(mcpUrl("https://api.example.com//")).toBe("https://api.example.com/mcp");
  });
});

describe("mcpSetupSnippets", () => {
  test("puts the URL in each agent's snippet", () => {
    const snippets = mcpSetupSnippets("https://api.draftai.us/mcp");
    expect(snippets[0]?.snippet).toBe("claude mcp add --transport http draft https://api.draftai.us/mcp");
    expect(snippets[1]?.snippet).toContain('url = "https://api.draftai.us/mcp"');
  });
});
