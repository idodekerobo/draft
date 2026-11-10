import { describe, expect, it } from "bun:test";
import { describeError } from "../../errors/describe-error";

describe("describeError", () => {
  it("uses the message of an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("uses the message of a Supabase error, which is a plain object", () => {
    expect(describeError({ code: "P0001", message: "connection_inactive" })).toBe("connection_inactive");
  });

  it("falls back to the text of anything else", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });
});
