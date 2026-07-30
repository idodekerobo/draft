import { describe, expect, it } from "bun:test";
import { parseSourceUnavailable } from "../synthesizers/source-result";

describe("source unavailable result", () => {
  it("parses the strict operational sentinel", () => {
    expect(parseSourceUnavailable('DRAFT_SOURCE_UNAVAILABLE {"code":"mcp_auth","message":"Authentication expired"}')).toEqual({
      kind: "source_unavailable",
      code: "mcp_auth",
      message: "Authentication expired",
    });
  });

  it("does not consume maintainer documents or invalid codes", () => {
    expect(parseSourceUnavailable("---\noutcome: no_change\n---")).toBeNull();
    expect(parseSourceUnavailable('DRAFT_SOURCE_UNAVAILABLE {"code":"other","message":"x"}')).toBeNull();
  });

  it("bounds stored error messages", () => {
    const parsed = parseSourceUnavailable(`DRAFT_SOURCE_UNAVAILABLE ${JSON.stringify({ code: "mcp_tool_error", message: "x".repeat(700) })}`);
    expect(parsed?.message.length).toBe(500);
  });
});
