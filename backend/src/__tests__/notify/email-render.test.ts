import { describe, expect, it } from "bun:test";
import { htmlToText, MAX_EMAIL_HTML_CHARS, MAX_EMAIL_SUBJECT_CHARS, MAX_EMAIL_TEXT_CHARS, normalizeSubject, renderEmail, textToHtml } from "../../notify/channels/email/render";

describe("normalizeSubject", () => {
  it("adds the Draft prefix once", () => {
    expect(normalizeSubject("Your meeting follow-ups")).toBe("Draft: Your meeting follow-ups");
    expect(normalizeSubject("Draft: Your meeting follow-ups")).toBe("Draft: Your meeting follow-ups");
    expect(normalizeSubject("draft:   weekly update")).toBe("Draft: weekly update");
  });
  it("uses the stable default when there is no subject", () => {
    expect(normalizeSubject(undefined)).toBe("Draft: New message");
    expect(normalizeSubject("  Draft:  ")).toBe("Draft: New message");
  });
  it("removes line breaks so a subject cannot add mail headers", () => {
    expect(normalizeSubject("Hi\r\nBcc: x@evil.com")).toBe("Draft: Hi Bcc: x@evil.com");
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs, list items and link targets, and drops tags, styles and scripts", () => {
    const text = htmlToText('<style>p{}</style><h1>Hi</h1><p>One &amp; two</p><ul><li>a</li><li>b</li></ul><p><a href="https://x.dev/a">the plan</a></p><script>x()</script>');
    expect(text).toBe("Hi\nOne & two\n\n- a\n- b\n\nthe plan (https://x.dev/a)");
  });
  it("prints a bare link once", () => {
    expect(htmlToText('<a href="https://x.dev">https://x.dev</a>')).toBe("https://x.dev");
  });
});

describe("textToHtml", () => {
  it("escapes the text and turns blank lines into paragraphs", () => {
    const html = textToHtml("a <b>\nc\n\nd");
    expect(html).toContain("<p>a &lt;b&gt;<br>c</p><p>d</p>");
    expect(html).not.toContain("<b>");
  });
});

describe("renderEmail", () => {
  it("makes text from html when text is missing", () => {
    const result = renderEmail({ subject: "Update", html: "<p>Hello</p>" });
    expect(result).toEqual({ ok: true, email: { subject: "Draft: Update", text: "Hello", html: "<p>Hello</p>" } });
  });
  it("makes html from text when html is missing", () => {
    const result = renderEmail({ text: "Hello" });
    expect(result.ok && result.email.html).toContain("<p>Hello</p>");
    expect(result.ok && result.email.subject).toBe("Draft: New message");
  });
  it("keeps both when both are given", () => {
    const result = renderEmail({ text: "plain", html: "<p>rich</p>" });
    expect(result.ok && [result.email.text, result.email.html]).toEqual(["plain", "<p>rich</p>"]);
  });
  it("ends the text and the html with the footer, inside the body tag when there is one", () => {
    const plain = renderEmail({ text: "Hello", footer: "Sent by Uzo through Draft" });
    expect(plain.ok && plain.email.text).toBe("Hello\n\nSent by Uzo through Draft");
    expect(plain.ok && plain.email.html.endsWith("Sent by Uzo through Draft</p>")).toBe(true);
    const full = renderEmail({ html: "<html><body><p>Hi</p></body></html>", footer: "A <b>footer</b>" });
    expect(full.ok && full.email.html).toMatch(/<p>Hi<\/p><p [^>]*>A &lt;b&gt;footer&lt;\/b&gt;<\/p><\/body><\/html>$/);
  });
  it("does not count the footer against the size limits", () => {
    expect(renderEmail({ text: "x".repeat(MAX_EMAIL_TEXT_CHARS), footer: "footer" }).ok).toBe(true);
  });
  it("rejects an empty body and over-long parts", () => {
    expect(renderEmail({ subject: "x" })).toEqual({ ok: false, code: "empty_body" });
    expect(renderEmail({ text: "   " })).toEqual({ ok: false, code: "empty_body" });
    expect(renderEmail({ text: "x".repeat(MAX_EMAIL_TEXT_CHARS + 1) })).toEqual({ ok: false, code: "text_too_long" });
    expect(renderEmail({ html: "x".repeat(MAX_EMAIL_HTML_CHARS + 1) })).toEqual({ ok: false, code: "html_too_long" });
    expect(renderEmail({ text: "x", subject: "s".repeat(MAX_EMAIL_SUBJECT_CHARS) })).toEqual({ ok: false, code: "subject_too_long" });
  });
});
