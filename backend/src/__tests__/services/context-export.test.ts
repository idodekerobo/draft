import { describe, expect, it } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import {
  buildContextExport,
  buildExportFiles,
  buildExportZip,
} from "../../services/context-export";
import type { WorkspaceContextSnapshot } from "../../services/workspace-context";

function snapshot(documents: Record<string, string>): WorkspaceContextSnapshot {
  return {
    versionId: "v-id",
    versionNumber: 7,
    contentHash: "hash",
    creationReason: "synthesis",
    createdAt: "2026-10-05T00:00:00Z",
    documents: Object.fromEntries(
      Object.entries(documents).map(([path, content]) => [path, { content, sha256: "x".repeat(64) }]),
    ),
  } as WorkspaceContextSnapshot;
}

describe("unsafe stored paths", () => {
  for (const bad of ["/abs.md", "../x.md", "a/../b.md", "a\\b.md", "a//b.md", ".hidden/x.md", "a/.x.md", "notes.txt", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => buildExportFiles(snapshot({ [bad]: "x" }))).toThrow();
    });
  }
});

describe("buildExportFiles", () => {
  it("includes every document, memory and log roots too, plus README and manifest", () => {
    const files = buildExportFiles(
      snapshot({ "company/index.md": "c", "memory/2026-10.md": "m", "log/a.md": "l", "accepted/b.md": "a" }),
      new Date("2026-10-05T12:00:00Z"),
    );
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(["README.md", "draft-export.json", "company/index.md", "memory/2026-10.md", "log/a.md", "accepted/b.md"]),
    );
    const manifest = JSON.parse(files.find((file) => file.path === "draft-export.json")!.content);
    expect(manifest).toEqual({
      versionNumber: 7,
      versionId: "v-id",
      contentHash: "hash",
      exportedAt: "2026-10-05T12:00:00.000Z",
    });
  });

  it("fails loudly on an unsafe stored path", () => {
    expect(() => buildExportFiles(snapshot({ "../evil.md": "x" }))).toThrow();
  });

  it("handles empty documents", () => {
    const paths = buildExportFiles(snapshot({})).map((file) => file.path);
    expect(paths).toEqual(["README.md", "draft-export.json"]);
  });
});

describe("buildExportZip", () => {
  it("round trips under one draft-context folder", () => {
    const zip = buildExportZip(buildExportFiles(snapshot({ "memory/2026-10.md": "hello" })));
    const entries = unzipSync(zip);
    expect(Object.keys(entries).every((name) => name.startsWith("draft-context/"))).toBe(true);
    expect(strFromU8(entries["draft-context/memory/2026-10.md"]!)).toBe("hello");
    expect(entries["draft-context/README.md"]).toBeDefined();
  });
});

describe("buildContextExport", () => {
  it("names the file by version and date", () => {
    const { fileName } = buildContextExport(snapshot({}), new Date("2026-10-05T12:00:00Z"));
    expect(fileName).toBe("draft-context-v7-2026-10-05.zip");
  });
});
