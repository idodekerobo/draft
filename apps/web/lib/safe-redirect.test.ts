import { describe, expect, test } from "bun:test";
import { safeNext } from "./safe-redirect";

describe("safeNext", () => {
  test("keeps plain relative paths", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext("/a?b=1#c")).toBe("/a?b=1#c");
  });

  test("falls back for empty values", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("", "/home")).toBe("/home");
  });

  test.each([
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "https://evil.com",
    "evil.com",
  ])("rejects %j", (candidate) => {
    expect(safeNext(candidate)).toBe("/");
  });
});
