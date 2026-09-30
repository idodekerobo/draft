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

  test("skips non-markdown, reserved roots and deep paths", () => {
    expect(toContextFileEntry("company/index.json", "")).toBeNull();
    expect(toContextFileEntry("log/x.md", "")).toBeNull();
    expect(toContextFileEntry("accepted/x.md", "")).toBeNull();
    expect(toContextFileEntry("a/b/c/d.md", "")).toBeNull();
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
