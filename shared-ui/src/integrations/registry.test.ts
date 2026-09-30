import { describe, expect, test } from "bun:test";
import { groupTools, toolsForPlatform } from "./registry";

describe("groupTools", () => {
  test("splits tools into Sources and Use Draft in your agent", () => {
    const sections = groupTools(toolsForPlatform("web"), {});
    expect(sections.map((s) => s.label)).toEqual(["Sources", "Use Draft in your agent"]);
    expect(sections[1]?.tools.map((t) => t.id)).toEqual(["claude-code"]);
    expect(sections[0]?.tools.map((t) => t.id)).toContain("coding-sessions");
  });

  test("lists connected sources first, then by popularity", () => {
    const [sources] = groupTools(toolsForPlatform("web"), { linear: { state: "connected" } });
    expect(sources?.tools[0]?.id).toBe("linear");
    expect(sources?.tools[1]?.id).toBe("slack");
  });

  test("drops a section when no tool in it is requested", () => {
    const sections = groupTools(toolsForPlatform("desktop", ["team", "meetings"]), {});
    expect(sections.map((s) => s.section)).toEqual(["sources"]);
  });
});
