import { describe, expect, it } from "bun:test";
import { latestNativeTitle } from "../../../ingestion/claude-code/native-title";

const line = (record: object, file = "root.jsonl") => ({ file, offset: 0, raw: JSON.stringify(record) });
const ai = (aiTitle: string) => line({ type: "ai-title", aiTitle });
const custom = (customTitle: string) => line({ type: "custom-title", customTitle });

describe("latestNativeTitle", () => {
  it("returns null when no line carries a title", () => {
    expect(latestNativeTitle([line({ type: "user" }), { file: "root.jsonl", offset: 1, oversizeBytes: 9 }], 120)).toBeNull();
  });

  it("takes the last ai-title", () => {
    expect(latestNativeTitle([ai("First"), ai("Second")], 120)).toBe("Second");
  });

  it("lets a custom title win over an ai-title in either order", () => {
    expect(latestNativeTitle([custom("auth-refactor"), ai("Generated")], 120)).toBe("auth-refactor");
    expect(latestNativeTitle([ai("Generated"), custom("auth-refactor")], 120)).toBe("auth-refactor");
  });

  it("ignores blank titles, subagent files and bad JSON", () => {
    const bad = { file: "root.jsonl", offset: 0, raw: "not json -title" };
    expect(latestNativeTitle([ai("   "), ai("Agent title"), bad], 120)).toBe("Agent title");
    expect(latestNativeTitle([line({ type: "ai-title", aiTitle: "Sub" }, "subagents/agent-1.jsonl")], 120)).toBeNull();
  });

  it("trims and caps the title", () => {
    expect(latestNativeTitle([ai("  abcdef  ")], 3)).toBe("abc");
  });
});
