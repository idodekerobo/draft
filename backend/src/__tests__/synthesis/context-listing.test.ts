import { describe, expect, it } from "bun:test";
import { capMemoryFiles, lastChangedLine, renderContextListing } from "../../synthesis/context-listing";
import type { DocumentLastChange } from "../../services/context-history";

const now = new Date("2026-11-25T12:00:00.000Z");
const file = (logicalPath: string) => ({ logicalPath, readPath: `input/context/${logicalPath}`, sha256: "a".repeat(64) });

const change = (path: string, createdAt: string, agentRunId: string | null = null, creationReason = "agent_write"): DocumentLastChange => ({
  path, versionId: "v", versionNumber: 4, createdAt, creationReason, agentRunId, summary: "s",
});

describe("capMemoryFiles", () => {
  const files = [
    "company/about.md", "memory/index.md", "memory/months/2026-09.md", "memory/months/2026-11.md",
    "memory/days/2026-11-25.md", "memory/days/2026-11-11.md", "memory/days/2026-11-10.md", "memory/days/2026-09-01.md",
    "memory/weeks/2026-11-23.md", "memory/weeks/2026-11-09.md", "memory/weeks/2026-10-05.md",
  ].map(file);

  it("keeps documents, the memory index and every month", () => {
    const paths = capMemoryFiles(files, now).listed.map((f) => f.logicalPath);
    expect(paths).toContain("company/about.md");
    expect(paths).toContain("memory/index.md");
    expect(paths).toContain("memory/months/2026-09.md");
    expect(paths).toContain("memory/months/2026-11.md");
  });

  it("keeps days and weeks of the last 14 days and drops older ones", () => {
    const { listed, omitted } = capMemoryFiles(files, now);
    const paths = listed.map((f) => f.logicalPath);
    // 14 days before the 25th at noon is the 11th at noon: the 11th ends after that, the 10th ends before it.
    expect(paths).toContain("memory/days/2026-11-25.md");
    expect(paths).toContain("memory/days/2026-11-11.md");
    expect(paths).not.toContain("memory/days/2026-11-10.md");
    expect(paths).not.toContain("memory/days/2026-09-01.md");
    // The week of Monday the 9th ends on the 15th, so it is still inside the window.
    expect(paths).toContain("memory/weeks/2026-11-09.md");
    expect(paths).toContain("memory/weeks/2026-11-23.md");
    expect(paths).not.toContain("memory/weeks/2026-10-05.md");
    expect(omitted).toBe(3);
  });

  it("leaves a path that only looks like a memory file alone", () => {
    expect(capMemoryFiles([file("memory/days/notes.md"), file("memory/other/2020-01-01.md")], now).omitted).toBe(0);
  });
});

describe("lastChangedLine", () => {
  it("gives the date, the age and the run that changed it", () => {
    expect(lastChangedLine(change("a.md", "2026-10-06T08:00:00.000Z", "run-9"), 300, now)).toBe("last changed: 2026-10-06, 50 days ago, by run run-9");
  });

  it("names the reason when no run made the change", () => {
    expect(lastChangedLine(change("a.md", "2026-11-25T01:00:00.000Z", null, "manual_edit"), 300, now)).toBe("last changed: 2026-11-25, today, (manual_edit)");
    expect(lastChangedLine(change("a.md", "2026-11-24T01:00:00.000Z"), 300, now)).toContain("1 day ago");
  });

  it("says a document is older than the versions read when it has no change", () => {
    expect(lastChangedLine(undefined, 300, now)).toBe("last changed: more than 300 versions ago, so it may be stale");
  });
});

describe("renderContextListing", () => {
  it("lists each file with its read path, hash and last change, and notes the omitted memory files", () => {
    const text = renderContextListing(
      [file("company/about.md"), file("memory/days/2026-09-01.md")],
      new Map([["company/about.md", change("company/about.md", "2026-11-20T00:00:00.000Z", "run-1")]]),
      300,
      now,
    );
    expect(text).toContain("- company/about.md\n  read from: input/context/company/about.md\n  sha256: " + "a".repeat(64) + "\n  last changed: 2026-11-20, 5 days ago, by run run-1");
    expect(text).not.toContain("memory/days/2026-09-01.md\n");
    expect(text).toContain("(1 older memory day and week files are not listed. Read one with context.read and its path.)");
  });

  it("says there is no context when there are no files", () => {
    expect(renderContextListing([], new Map(), 300, now)).toBe("(no existing context)");
  });
});
