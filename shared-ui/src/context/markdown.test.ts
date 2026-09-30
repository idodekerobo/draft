import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

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
