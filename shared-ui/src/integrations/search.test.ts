import { describe, expect, test } from "bun:test";
import { filterToolGroups, groupTools, TOOL_REGISTRY, type ToolStatus } from "./registry";

const statuses: Partial<Record<(typeof TOOL_REGISTRY)[number]["id"], ToolStatus>> = {};
const grouped = groupTools(TOOL_REGISTRY, statuses);

describe("connection search", () => {
  test("matches provider names case-insensitively and trims whitespace", () => {
    expect(filterToolGroups(grouped, "  lIN ").flatMap((section) => section.tools.map((tool) => tool.name))).toEqual(["Linear"]);
  });

  test("matches agent aliases", () => {
    expect(filterToolGroups(grouped, "codex").flatMap((section) => section.tools.map((tool) => tool.id))).toEqual(["claude-code"]);
  });

  test("keeps section grouping and removes empty sections", () => {
    const result = filterToolGroups(grouped, "fire");
    expect(result).toHaveLength(1);
    expect(result[0]?.section).toBe("sources");
    expect(result[0]?.tools.map((tool) => tool.id)).toEqual(["fireflies"]);
  });

  test("returns all sections for whitespace and no sections for no matches", () => {
    expect(filterToolGroups(grouped, "   ")).toHaveLength(grouped.length);
    expect(filterToolGroups(grouped, "unknown-provider")).toEqual([]);
  });
});
