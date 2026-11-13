import { describe, expect, test } from "bun:test";
import { markdownBlocks, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  test("renders ordinary markdown", () => {
    expect(renderMarkdown("# Team\n\n**Maya** leads [design](https://example.com).")).toContain('<a href="https://example.com"');
  });

  test("escapes raw HTML", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  test("drops unsafe link targets but keeps the text", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("href");
    expect(html).toContain("click");
  });

  test("renders images as alt text only", () => {
    expect(renderMarkdown("![logo](https://evil.example/x.png)")).not.toContain("<img");
  });
});

describe("markdownBlocks", () => {
  const samples = [
    "",
    "\n\n",
    "\n\n# Title\n\nFirst.\n\nSecond.\n\n",
    "text\n   \n",
    "a\r\n\r\nb\r\n",
    "- one\n- two\n\n\n```js\nconst x = 1;\n```\n",
  ];

  test("joined blocks give back the input", () => {
    for (const sample of samples) expect(markdownBlocks(sample).join("")).toBe(sample);
  });

  test("rendering the blocks matches rendering the whole text", () => {
    const full = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n";
    const squash = (html: string) => html.replace(/>\s+</g, "><").trim();
    const fromBlocks = markdownBlocks(full).map(renderMarkdown).join("");
    expect(squash(fromBlocks)).toBe(squash(renderMarkdown(full)));
  });
});
