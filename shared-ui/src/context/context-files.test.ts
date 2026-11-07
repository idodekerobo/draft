import { describe, expect, test } from "bun:test";
import { contextExcerpt, documentsToEntries, parseFrontmatterFields, splitFrontmatter, toContextFileEntry } from "./context-files";

const doc = (content: string) => ({ content, sha256: "x" });

describe("toContextFileEntry", () => {
  test("maps each path shape to its kind", () => {
    expect(toContextFileEntry("company/index.md", "body")).toMatchObject({ kind: "dim", group: "company", label: "Company" });
    expect(toContextFileEntry("company/log/20260514_call.md", "")).toMatchObject({ kind: "log", group: "company", label: "May 14" });
    expect(toContextFileEntry("tensions.md", "")).toMatchObject({ kind: "standalone", group: "tensions", label: "Tensions" });
    expect(toContextFileEntry("decisions/pricing-model.md", "")).toMatchObject({ kind: "group-child", group: "decisions", label: "Pricing Model", groupLabel: "Decisions" });
  });

  test("maps nested subfolder files into a section with readable dated labels", () => {
    expect(toContextFileEntry("memory/days/2026-11-07.md", "")).toMatchObject({ kind: "group-child", group: "memory", groupLabel: "Memory · Days", label: "Nov 7" });
    expect(toContextFileEntry("memory/weeks/2026-11-02.md", "")).toMatchObject({ groupLabel: "Memory · Weeks", label: "Week of Nov 2" });
    expect(toContextFileEntry("memory/months/2026-11.md", "")).toMatchObject({ groupLabel: "Memory · Months", label: "Nov 2026" });
    expect(toContextFileEntry("research/competitors/acme-notes.md", "")).toMatchObject({ groupLabel: "Research · Competitors", label: "Acme Notes" });
  });

  test("skips non-markdown, reserved roots and deep paths", () => {
    expect(toContextFileEntry("company/index.json", "")).toBeNull();
    expect(toContextFileEntry("log/x.md", "")).toBeNull();
    expect(toContextFileEntry("accepted/x.md", "")).toBeNull();
    expect(toContextFileEntry("a/b/c/d.md", "")).toBeNull();
    expect(toContextFileEntry("memory/days/2026-11-07.json", "")).toBeNull();
  });

  test("strips frontmatter into frontmatterRaw", () => {
    const entry = toContextFileEntry("team/index.md", "---\nname: team\n---\n# Team\n");
    expect(entry?.frontmatterRaw).toBe("---\nname: team\n---\n");
    expect(entry?.content).toBe("# Team\n");
  });
});

describe("documentsToEntries", () => {
  test("orders standard dims first, logs after their dim, then standalone, then groups", () => {
    const entries = documentsToEntries({
      "zeta/other.md": doc(""),
      "notes.md": doc(""),
      "customers/index.md": doc(""),
      "product/log/20260101_a.md": doc(""),
      "product/index.md": doc(""),
      "company/index.md": doc(""),
    });
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "company/index.md",
      "product/index.md",
      "product/log/20260101_a.md",
      "customers/index.md",
      "notes.md",
      "zeta/other.md",
    ]);
  });
});

describe("documentsToEntries nested sections", () => {
  test("orders subfolders months, weeks, days and dated files newest first", () => {
    const entries = documentsToEntries({
      "memory/days/2026-11-06.md": doc(""),
      "memory/days/2026-11-07.md": doc(""),
      "memory/weeks/2026-11-02.md": doc(""),
      "memory/months/2026-10.md": doc(""),
      "memory/months/2026-11.md": doc(""),
      "memory/index.md": doc(""),
    });
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "memory/index.md",
      "memory/months/2026-11.md",
      "memory/months/2026-10.md",
      "memory/weeks/2026-11-02.md",
      "memory/days/2026-11-07.md",
      "memory/days/2026-11-06.md",
    ]);
  });
});

describe("frontmatter helpers", () => {
  test("splitFrontmatter leaves content without frontmatter alone", () => {
    expect(splitFrontmatter("# Hi")).toEqual({ frontmatterRaw: "", body: "# Hi" });
  });

  test("parseFrontmatterFields reads name, last_updated and source", () => {
    expect(parseFrontmatterFields("---\nname: company\nlast_updated: '2026-09-26'\nsource: Slack, Fireflies\n---\n"))
      .toEqual({ name: "company", last_updated: "2026-09-26", source: "Slack, Fireflies" });
  });
});

describe("contextExcerpt", () => {
  test("returns the first prose paragraph without markup", () => {
    expect(contextExcerpt("# Company\n\n- list\n\nCedar Frame is a **nine-person** [agency](https://x.y).\n\nMore."))
      .toBe("Cedar Frame is a nine-person agency.");
  });

  test("truncates on a word boundary", () => {
    expect(contextExcerpt("one two three four five", 12)).toBe("one two…");
  });
});
