import { describe, expect, it } from "bun:test";
import { envTree, filesUnder, folderState } from "./env-tree";

describe("envTree", () => {
  const tree = envTree([".env", ".claude/a/.env", ".claude/b/.env.local", "apps/web/.env"]);

  it("groups files under their folders and keeps top-level files on the root", () => {
    expect(tree.files).toEqual([".env"]);
    expect(tree.folders.map((f) => f.path)).toEqual([".claude", "apps"]);
    expect(filesUnder(tree.folders[0]!)).toEqual([".claude/a/.env", ".claude/b/.env.local"]);
  });

  it("marks a folder all, some or none ticked", () => {
    const claude = tree.folders[0]!;
    expect(folderState(claude, new Set())).toBe("none");
    expect(folderState(claude, new Set([".claude/a/.env"]))).toBe("some");
    expect(folderState(claude, new Set(filesUnder(claude)))).toBe("all");
  });
});
