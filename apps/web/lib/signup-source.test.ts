import { describe, expect, it } from "bun:test";
import { createOrgPath, parseSignupSource } from "./signup-source";

describe("parseSignupSource", () => {
  it("accepts the known sources", () => {
    expect(parseSignupSource("download")).toBe("download");
    expect(parseSignupSource("join")).toBe("join");
    expect(parseSignupSource("desktop")).toBe("desktop");
    expect(parseSignupSource("multiplayer-coding")).toBe("multiplayer-coding");
  });

  it("maps anything else to direct", () => {
    expect(parseSignupSource(undefined)).toBe("direct");
    expect(parseSignupSource("<script>")).toBe("direct");
    expect(parseSignupSource(["download"])).toBe("direct");
  });
});

describe("createOrgPath", () => {
  it("has no query for a direct signup", () => {
    expect(createOrgPath("direct")).toBe("/onboarding/create");
  });

  it("keeps the source", () => {
    expect(createOrgPath("download")).toBe("/onboarding/create?src=download");
    expect(createOrgPath("join")).toBe("/onboarding/create?src=join");
  });

  it("encodes a next path that has its own query", () => {
    const path = createOrgPath("desktop", "/link?code=abc");
    expect(path).toBe("/onboarding/create?src=desktop&next=%2Flink%3Fcode%3Dabc");
    expect(new URL(path, "http://x").searchParams.get("next")).toBe("/link?code=abc");
  });
});
