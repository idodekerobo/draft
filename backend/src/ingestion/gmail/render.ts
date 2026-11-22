import type { GmailMessage, GmailMessagePart } from "./api";

export interface RenderedAttachment {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
}

export interface RenderedMessage {
  id: string;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  labels: string[];
  body_text: string;
  attachments: RenderedAttachment[];
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function header(part: GmailMessagePart | undefined, name: string): string | null {
  const found = part?.headers?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = firstPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function collectAttachments(part: GmailMessagePart | undefined, out: RenderedAttachment[]): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachment_id: part.body.attachmentId,
      filename: part.filename,
      mime_type: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
}

// Prefers the first text/plain part; falls back to text/html as plain text. Never returns HTML.
export function extractBodyText(payload: GmailMessagePart | undefined): string {
  const plain = firstPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).trim();
  const html = firstPart(payload, "text/html");
  return html?.body?.data ? htmlToText(decodeBase64Url(html.body.data)) : "";
}

export function renderMessage(message: GmailMessage): RenderedMessage {
  const internalMs = message.internalDate ? Number(message.internalDate) : NaN;
  const attachments: RenderedAttachment[] = [];
  collectAttachments(message.payload, attachments);
  return {
    id: message.id,
    thread_id: message.threadId ?? null,
    from: header(message.payload, "From"),
    to: header(message.payload, "To"),
    cc: header(message.payload, "Cc"),
    subject: header(message.payload, "Subject"),
    date: Number.isFinite(internalMs) ? new Date(internalMs).toISOString() : header(message.payload, "Date"),
    snippet: message.snippet ? decodeEntities(message.snippet) : null,
    labels: message.labelIds ?? [],
    body_text: extractBodyText(message.payload),
    attachments,
  };
}
