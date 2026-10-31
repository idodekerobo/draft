import { describe, expect, it } from "bun:test";
import { calAnswersToProfile } from "../../waitlist/cal-profile";
import {
  AI_TOOL_CODES,
  AI_TOOL_LABELS,
  ROLE_CODES,
  ROLE_LABELS,
  TEAM_SIZE_CODES,
  TEAM_SIZE_LABELS,
} from "../../waitlist/questions";

describe("question labels", () => {
  it("have one label for every code", () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLE_CODES].sort());
    expect(Object.keys(TEAM_SIZE_LABELS).sort()).toEqual([...TEAM_SIZE_CODES].sort());
    expect(Object.keys(AI_TOOL_LABELS).sort()).toEqual([...AI_TOOL_CODES].sort());
  });
});

describe("calAnswersToProfile", () => {
  it("maps option labels to codes", () => {
    expect(
      calAnswersToProfile({
        name: "Sam",
        role: "Operations",
        team_size: "51-100",
        ai_tools: ["Claude", "Coding Agents", "None yet"],
        use_case: "roll out AI",
        how_heard: "search",
      }),
    ).toEqual({
      profile_version: "2",
      name: "Sam",
      role: "operations",
      team_size: "51_100",
      ai_tools: "claude,coding_agents,none",
      use_case: "roll out AI",
      how_heard: "search",
    });
  });

  it("ignores case and drops labels it does not know", () => {
    expect(calAnswersToProfile({ role: "founder", team_size: "about ten", ai_tools: "Gemini" })).toEqual({
      profile_version: "2",
      role: "founder",
    });
  });

  it("returns an empty profile when nothing usable arrives", () => {
    expect(calAnswersToProfile({})).toEqual({});
  });
});
