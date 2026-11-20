import { describe, expect, it } from "bun:test";
import { htmlToText, renderMessage } from "../../ingestion/gmail/render";
import type { GmailMessage } from "../../ingestion/gmail/api";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const headers = [
  { name: "From", value: "Ada <ada@x.com>" },
  { name: "To", value: "me@x.com" },
  { name: "Cc", value: "bo@x.com" },
  { name: "Subject", value: "Plans" },
];

describe("renderMessage", () => {
  it("renders a plain-text message with its headers", () => {
    const message: GmailMessage = {
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.UTC(2026, 0, 2)),
      labelIds: ["INBOX"],
      snippet: "Hi &amp; bye",
      payload: { mimeType: "text/plain", headers, body: { data: b64("Hello there\n") } },
    };
    expect(renderMessage(message)).toEqual({
      id: "m1",
      thread_id: "t1",
      from: "Ada <ada@x.com>",
      to: "me@x.com",
      cc: "bo@x.com",
      subject: "Plans",
      date: "2026-01-02T00:00:00.000Z",
      snippet: "Hi & bye",
      labels: ["INBOX"],
      body_text: "Hello there",
      attachments: [],
    });
  });

  it("turns an HTML-only body into text and never returns HTML", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Hi&nbsp;Ada &amp; Bo</p><p>Line&#33;</p><br><br><br><div>End &#x263A;</div></body></html>";
    const rendered = renderMessage({ id: "m1", payload: { mimeType: "text/html", headers, body: { data: b64(html) } } });
    expect(rendered.body_text).toBe("Hi Ada & Bo\nLine!\n\nEnd ☺");
    expect(rendered.body_text).not.toContain("<");
  });

  it("prefers the first text/plain part of a multipart message", () => {
    const rendered = renderMessage({
      id: "m1",
      payload: {
        mimeType: "multipart/mixed",
        headers,
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("plain one") } },
              { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
            ],
          },
          { mimeType: "text/plain", body: { data: b64("plain two") } },
        ],
      },
    });
    expect(rendered.body_text).toBe("plain one");
  });

  it("lists attachments without their content", () => {
    const rendered = renderMessage({
      id: "m1",
      payload: {
        mimeType: "multipart/mixed",
        headers,
        parts: [
          { mimeType: "text/plain", body: { data: b64("see attached") } },
          { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att-1", size: 1234 } },
          { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att-2", size: 10 } },
        ],
      },
    });
    expect(rendered.body_text).toBe("see attached");
    expect(rendered.attachments).toEqual([
      { attachment_id: "att-1", filename: "deck.pdf", mime_type: "application/pdf", size: 1234 },
      { attachment_id: "att-2", filename: "notes.txt", mime_type: "text/plain", size: 10 },
    ]);
  });

  it("falls back to the Date header when internalDate is missing", () => {
    const rendered = renderMessage({ id: "m1", payload: { headers: [{ name: "Date", value: "Fri, 2 Jan 2026" }] } });
    expect(rendered.date).toBe("Fri, 2 Jan 2026");
    expect(rendered.body_text).toBe("");
  });
});

describe("htmlToText", () => {
  it("drops scripts and comments", () => {
    expect(htmlToText("<script>x()</script><!-- hi --><b>Bold</b>")).toBe("Bold");
  });
});
