import { describe, expect, test } from "bun:test";
import { commentsHash, renderComments, withComments, type DriveComment } from "../../ingestion/google-drive/comments";
import { renderDocument } from "../../ingestion/google-drive/render-doc";
import { MAX_MARKDOWN_CHARS } from "../../ingestion/google-drive/render-common";
import { MAX_SHEET_ROWS, renderSpreadsheet } from "../../ingestion/google-drive/render-sheet";
import { renderPresentation } from "../../ingestion/google-drive/render-slides";

const para = (text: string, extra: Record<string, unknown> = {}) => ({
  paragraph: { elements: [{ textRun: { content: `${text}\n` } }], ...extra },
});

describe("renderDocument", () => {
  test("renders headings, lists, links and tables", () => {
    const doc = {
      title: "Plan",
      tabs: [
        {
          documentTab: {
            lists: { l1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } }, l2: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } } },
            body: {
              content: [
                para("Goals", { paragraphStyle: { namedStyleType: "HEADING_2" } }),
                para("Ship it", { bullet: { listId: "l2", nestingLevel: 0 } }),
                para("First", { bullet: { listId: "l1", nestingLevel: 0 } }),
                { paragraph: { elements: [{ textRun: { content: "docs\n", textStyle: { link: { url: "https://x.test" } } } }] } },
                { table: { tableRows: [{ tableCells: [{ content: [para("Name")] }, { content: [para("Owner")] }] }, { tableCells: [{ content: [para("Q4")] }, { content: [para("Ana")] }] }] } },
              ],
            },
          },
        },
      ],
    };
    const out = renderDocument(doc);
    expect(out.markdown).toContain("# Plan");
    expect(out.markdown).toContain("## Goals");
    expect(out.markdown).toContain("- Ship it");
    expect(out.markdown).toContain("1. First");
    expect(out.markdown).toContain("[docs](https://x.test)");
    expect(out.markdown).toContain("| Name | Owner |");
    expect(out.markdown).toContain("| Q4 | Ana |");
    expect(out.truncated).toBe(false);
  });

  test("labels each tab when there are several", () => {
    const tab = (title: string, text: string) => ({ tabProperties: { title }, documentTab: { body: { content: [para(text)] } } });
    const out = renderDocument({ tabs: [tab("One", "alpha"), tab("Two", "beta")] });
    expect(out.markdown).toContain("Tab: One");
    expect(out.markdown).toContain("Tab: Two");
  });

  test("truncates very long documents and strips signed image URLs", () => {
    const long = "word ".repeat(MAX_MARKDOWN_CHARS);
    const out = renderDocument({ body: { content: [para(long)] }, inlineObjects: { a: { contentUri: "https://signed" } } } as never);
    expect(out.truncated).toBe(true);
    expect(out.markdown).toContain("[Truncated");
    expect(JSON.stringify(out.structured)).not.toContain("https://signed");
  });
});

describe("renderSpreadsheet", () => {
  test("renders one table per tab and keeps exact values in structured", () => {
    const out = renderSpreadsheet(
      { properties: { title: "Budget" }, sheets: [{ properties: { title: "Q3" } }, { properties: { title: "Q4" } }] },
      [{ range: "Q3!A1:B2", values: [["Item", "Cost"], ["Ads", 1200]] }, { range: "Q4!A1:A1", values: [["x"]] }],
    );
    expect(out.markdown).toContain("## Q3");
    expect(out.markdown).toContain("| Ads | 1200 |");
    expect(out.markdown).toContain("## Q4");
    expect((out.structured as { tabs: { values: string[][] }[] }).tabs[0].values[1]).toEqual(["Ads", "1200"]);
  });

  test("caps rows and says so", () => {
    const values = Array.from({ length: MAX_SHEET_ROWS + 50 }, (_, i) => [`r${i}`]);
    const out = renderSpreadsheet({ sheets: [{ properties: { title: "Big" } }] }, [{ range: "Big!A:A", values }]);
    expect(out.truncated).toBe(true);
    expect(out.markdown).toContain("[Truncated: showing up to");
    expect((out.structured as { tabs: { values: string[][] }[] }).tabs[0].values).toHaveLength(MAX_SHEET_ROWS + 50);
  });

  test("handles an empty tab", () => {
    const out = renderSpreadsheet({ sheets: [{ properties: { title: "Empty" } }] }, [{ range: "Empty!A1" }]);
    expect(out.markdown).toContain("(empty)");
  });
});

describe("renderPresentation", () => {
  test("renders title, body, table and speaker notes per slide", () => {
    const text = (content: string) => ({ textElements: [{ textRun: { content } }] });
    const out = renderPresentation({
      title: "Deck",
      slides: [
        {
          pageElements: [
            { shape: { placeholder: { type: "TITLE" }, text: text("Roadmap\n") } },
            { shape: { text: text("Ship Drive\n") } },
            { table: { tableRows: [{ tableCells: [{ text: text("Q") }, { text: text("Goal") }] }, { tableCells: [{ text: text("Q4") }, { text: text("Launch") }] }] } },
          ],
          slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "n1" }, pageElements: [{ objectId: "n1", shape: { text: text("Say the date\n") } }] } },
        },
      ],
    });
    expect(out.markdown).toContain("## Slide 1: Roadmap");
    expect(out.markdown).toContain("Ship Drive");
    expect(out.markdown).toContain("| Q4 | Launch |");
    expect(out.markdown).toContain("Speaker notes: Say the date");
  });
});

describe("comments", () => {
  const comments: DriveComment[] = [
    { author: { displayName: "Ana" }, content: "Is this the final number?", quotedFileContent: { value: "$1.2M" }, replies: [{ author: { displayName: "Bo" }, content: "Yes.", createdTime: "t1" }] },
    { author: { displayName: "Cy" }, content: "Typo", resolved: true },
  ];

  test("renders threads with quotes, replies and resolved state", () => {
    const md = renderComments(comments);
    expect(md).toContain("## Comments");
    expect(md).toContain("> $1.2M");
    expect(md).toContain("- Ana: Is this the final number?");
    expect(md).toContain("  - Bo: Yes.");
    expect(md).toContain("Cy (resolved): Typo");
  });

  test("a new reply changes the hash; no comments gives an empty hash", () => {
    const before = commentsHash(comments);
    const after = commentsHash([comments[0], { ...comments[1], replies: [{ content: "fixed", createdTime: "t2" }] }]);
    expect(before).not.toBe(after);
    expect(commentsHash([])).toBe("");
  });

  test("renders a deleted comment or reply as (deleted), and deleting or editing changes the hash", () => {
    const deleted: DriveComment[] = [{ ...comments[0], deleted: true, content: "" }, { ...comments[1], replies: [{ author: { displayName: "Di" }, deleted: true, createdTime: "t3" }] }];
    const md = renderComments(deleted);
    expect(md).toContain("- Ana: (deleted)");
    expect(md).toContain("  - Di: (deleted)");
    expect(commentsHash(deleted)).not.toBe(commentsHash(comments));
    expect(commentsHash([{ ...comments[0], content: "Is this final?" }, comments[1]])).not.toBe(commentsHash(comments));
  });

  test("withComments appends markdown and a comments array", () => {
    const out = withComments({ markdown: "# Doc", structured: { title: "Doc" }, truncated: false }, comments);
    expect(out.markdown).toContain("## Comments");
    expect((out.structured as { comments: unknown[] }).comments).toHaveLength(2);
    const same = withComments({ markdown: "# Doc", structured: {}, truncated: false }, []);
    expect(same.markdown).toBe("# Doc");
  });
});
