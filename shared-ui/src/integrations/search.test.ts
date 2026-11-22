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

  test("finds Gmail by gmail or email, and both Google tools by google", () => {
    for (const query of ["gmail", "email"]) {
      expect(filterToolGroups(grouped, query).flatMap((section) => section.tools.map((tool) => tool.id))).toEqual(["gmail"]);
    }
    expect(filterToolGroups(grouped, "Google").flatMap((section) => section.tools.map((tool) => tool.id)).sort()).toEqual(["gmail", "google-drive"]);
  });

  test("finds Google Drive by drive, docs, sheets or slides", () => {
    for (const query of ["drive", "Docs", "sheets", "slides"]) {
      expect(filterToolGroups(grouped, query).flatMap((section) => section.tools.map((tool) => tool.id))).toEqual(["google-drive"]);
    }
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
