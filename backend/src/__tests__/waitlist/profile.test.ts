import { describe, expect, it } from "bun:test";
import { cleanProfile } from "../../waitlist/profile";

describe("cleanProfile", () => {
  it("keeps the old free-text keys when profile_version is absent", () => {
    expect(
      cleanProfile({ how_heard: " a friend ", use_case: "notes", team_size: "about 10", role: "founder", extra: "x" }),
    ).toEqual({ how_heard: "a friend", use_case: "notes", team_size: "about 10" });
  });

  it("keeps known codes and text for version 2", () => {
    expect(
      cleanProfile({
        profile_version: "2",
        name: "  Sam ",
        role: "operations",
        team_size: "11_50",
        ai_tools: ["claude", "cursor"],
        use_case: "roll out AI",
        how_heard: "search",
      }),
    ).toEqual({
      profile_version: "2",
      name: "Sam",
      role: "operations",
      team_size: "11_50",
      ai_tools: "claude,cursor",
      use_case: "roll out AI",
      how_heard: "search",
    });
  });

  it("drops unknown codes and free text in select fields", () => {
    expect(cleanProfile({ profile_version: "2", role: "ceo", team_size: "about 10", ai_tools: ["claude", "gemini"] })).toEqual({
      profile_version: "2",
      ai_tools: "claude",
    });
  });

  it("accepts ai_tools as a comma-separated string and removes duplicates", () => {
    expect(cleanProfile({ profile_version: "2", ai_tools: "cursor, cursor,none,bogus" })).toEqual({
      profile_version: "2",
      ai_tools: "cursor,none",
    });
  });

  it("limits text length", () => {
    const result = cleanProfile({ profile_version: "2", name: "n".repeat(500), how_heard: "h".repeat(500), use_case: "u".repeat(5000) });
    expect(result.name).toHaveLength(100);
    expect(result.how_heard).toHaveLength(200);
    expect(result.use_case).toHaveLength(1000);
  });

  it("returns an empty object when nothing valid is sent", () => {
    expect(cleanProfile(null)).toEqual({});
    expect(cleanProfile("text")).toEqual({});
    expect(cleanProfile({ profile_version: "2", role: "ceo" })).toEqual({});
  });
});
