import { DEFAULT_EMAIL_SUBJECT, EMAIL_SUBJECT_PREFIX } from "./constants";

export const MAX_EMAIL_SUBJECT_CHARS = 150;
export const MAX_EMAIL_TEXT_CHARS = 20_000;
export const MAX_EMAIL_HTML_CHARS = 100_000;

export type EmailContent = { subject: string; text: string; html: string };
export type EmailRenderResult = { ok: true; email: EmailContent } | { ok: false; code: "empty_body" | "subject_too_long" | "text_too_long" | "html_too_long" };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Readable plain text from agent-written HTML. It is a fallback for clients that show text, not a full renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, "").trim();
      return plain && plain !== href ? `${plain} (${href})` : href;
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)>/gi, "\n\n")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A basic email body for text the agent wrote without HTML. Blank lines start new paragraphs. */
export function textToHtml(text: string): string {
  const paragraphs = text.trim().split(/\n{2,}/).map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`);
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${paragraphs.join("")}</div>`;
}

/** One line, with the `Draft:` prefix present exactly once. Line breaks are removed so a subject cannot add mail headers. */
export function normalizeSubject(subject: string | undefined): string {
  const line = (subject ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const topic = line.replace(/^draft:\s*/i, "").trim();
  return topic ? `${EMAIL_SUBJECT_PREFIX}${topic}` : DEFAULT_EMAIL_SUBJECT;
}

/** Builds the subject, text and HTML for one email from whatever the agent supplied. Needs `text` or `html`. */
export function renderEmail(input: { subject?: string; text?: string; html?: string }): EmailRenderResult {
  const text = input.text?.trim() ?? "";
  const html = input.html?.trim() ?? "";
  if (!text && !html) return { ok: false, code: "empty_body" };
  if (text.length > MAX_EMAIL_TEXT_CHARS) return { ok: false, code: "text_too_long" };
  if (html.length > MAX_EMAIL_HTML_CHARS) return { ok: false, code: "html_too_long" };
  const subject = normalizeSubject(input.subject);
  if (subject.length > MAX_EMAIL_SUBJECT_CHARS) return { ok: false, code: "subject_too_long" };
  return { ok: true, email: { subject, text: text || htmlToText(html), html: html || textToHtml(text) } };
}
