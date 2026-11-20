import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/tools";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../../config";
import { gmailAccessFor } from "../../../ingestion/gmail/access";
import { GmailApiError, type GmailApi } from "../../../ingestion/gmail/api";
import { renderMessage } from "../../../ingestion/gmail/render";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";

export interface GmailToolDeps {
  fetch?: typeof fetch;
  settings?: () => GoogleOAuthSettings | null;
}

const METADATA_CONCURRENCY = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type GmailCursor = { v: 1; kind: "gmail_read" | "gmail_attachment"; id: string; offset: number };

const redactCursor = (cursor: string | undefined) => (cursor ? "[redacted]" : undefined);

function encodeCursor(value: GmailCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string, kind: GmailCursor["kind"], id: string): number | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GmailCursor>;
    if (parsed.v !== 1 || parsed.kind !== kind || parsed.id !== id) return null;
    return Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : null;
  } catch {
    return null;
  }
}

const invalidCursor = () => refuse("invalid_cursor", "That cursor isn't one this tool returned for this id. Pass next_cursor from the previous page.");

/** Moves `end` back so a UTF-8 slice never splits a character. */
function charBoundary(bytes: Buffer, end: number): number {
  let at = Math.min(end, bytes.length);
  while (at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at--;
  return at;
}

function gmailDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10).replaceAll("-", "/");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createGmailTools(client: SupabaseClient, deps: GmailToolDeps = {}) {
  const settings = deps.settings ?? googleOAuthSettings;

  async function withGmail(caller: ToolCaller, work: (api: GmailApi) => Promise<ToolHandlerResult>): Promise<ToolHandlerResult> {
    const userId = caller.onBehalfOf;
    if (!userId) return refuse("gmail_requires_person", "Gmail needs a person's own login.");
    const access = await gmailAccessFor(client, caller.workspaceId, userId, { settings, fetchImpl: deps.fetch ?? fetch });
    if (!access.ok) return refuse(access.code, access.message);
    try {
      return await work(access.api);
    } catch (cause) {
      if (!(cause instanceof GmailApiError)) throw cause;
      if (cause.code === "forbidden" || cause.code === "not_found") return refuse("gmail_not_found", "This message does not exist or you cannot open it.");
      if (cause.code === "rate_limited") return refuse("gmail_rate_limited", "Gmail is limiting requests right now. Try again in a minute.");
      if (cause.code === "unauthorized") return refuse("google_reconnect_required", "Reconnect Google");
      throw cause;
    }
  }

  const search = defineTool({
    name: "gmail.search", mcp: true, requiresConnection: "gmail",
    description: "Search the Gmail of the person you work for, with Gmail search syntax (from:, subject:, has:attachment, ...). Returns message ids, senders, subjects and snippets, newest first. Read a message or thread with gmail.read. Only that person's own mailbox; nothing is stored.",
    input: z.object({
      query: z.string().min(1).max(500).describe("Gmail search syntax, as in the Gmail search box."),
      since: z.string().optional().describe("Inclusive ISO date. Added to the query as after:."),
      until: z.string().optional().describe("ISO date. Added to the query as before:."),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().max(500).optional().describe("The next_cursor of the previous page."),
    }),
    auditArguments: (input) => ({ ...input, query: "[redacted]", cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const terms = [input.query];
      for (const [operator, value] of [["after", input.since], ["before", input.until]] as const) {
        if (value === undefined) continue;
        const date = gmailDate(value);
        if (!date) return refuse("invalid_input", `${operator === "after" ? "since" : "until"} must be an ISO date.`);
        terms.push(`${operator}:${date}`);
      }
      return withGmail(caller, async (api) => {
        const page = await api.listMessageIds(terms.join(" "), { pageToken: input.cursor, maxResults: input.limit ?? 20 });
        const messages = await mapLimit(page.ids, METADATA_CONCURRENCY, async (id) => {
          const rendered = renderMessage(await api.getMessage(id, "metadata"));
          return { id: rendered.id, thread_id: rendered.thread_id, from: rendered.from, subject: rendered.subject, date: rendered.date, snippet: rendered.snippet };
        });
        return { status: "ok", output: { messages, next_cursor: page.nextPageToken ?? null } };
      });
    },
  });

  const read = defineTool({
    name: "gmail.read", mcp: true, requiresConnection: "gmail",
    description: "Read one Gmail message (message_id) or a whole thread (thread_id) from the mailbox of the person you work for. Bodies are plain text, cut to max_bytes; when truncated, pass next_cursor back as cursor with the same id for the rest. Lists attachments for gmail.attachment.",
    input: z.object({
      message_id: z.string().min(1).max(200).optional(),
      thread_id: z.string().min(1).max(200).optional(),
      max_bytes: z.number().int().min(1024).max(262144).optional(),
      cursor: z.string().max(500).optional(),
    }),
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const id = input.message_id ?? input.thread_id;
      if (!id || (input.message_id && input.thread_id)) return refuse("invalid_input", "Pass exactly one of message_id or thread_id.");
      const cursorId = input.message_id ? `message:${id}` : `thread:${id}`;
      const offset = input.cursor ? decodeCursor(input.cursor, "gmail_read", cursorId) : 0;
      if (offset === null) return invalidCursor();
      const budget = input.max_bytes ?? 32768;
      return withGmail(caller, async (api) => {
        const raw = input.message_id ? [await api.getMessage(id)] : (await api.getThread(id)).messages;
        const messages = [];
        let position = 0;
        let remaining = budget;
        let truncatedAt: number | null = null;
        for (const message of raw.map(renderMessage)) {
          const body = Buffer.from(message.body_text, "utf8");
          const start = Math.max(offset - position, 0);
          position += body.length;
          if (start >= body.length && body.length > 0) continue;
          if (remaining === 0 && start < body.length) {
            truncatedAt = position - body.length + start;
            break;
          }
          const end = charBoundary(body, start + remaining);
          messages.push({ ...message, body_text: body.subarray(start, end).toString("utf8") });
          remaining -= end - start;
          if (end < body.length) truncatedAt = position - body.length + end;
        }
        const next_cursor = truncatedAt === null ? null : encodeCursor({ v: 1, kind: "gmail_read", id: cursorId, offset: truncatedAt });
        return { status: "ok", output: { messages, truncated: truncatedAt !== null, next_cursor } };
      });
    },
  });

  const attachment = defineTool({
    name: "gmail.attachment", mcp: true, requiresConnection: "gmail",
    description: "Download a Gmail attachment listed by gmail.read, as base64, max_bytes at a time. When truncated, pass next_cursor back as cursor with the same ids for the next part. Attachments over 10 MB are refused.",
    input: z.object({
      message_id: z.string().min(1).max(200),
      attachment_id: z.string().min(1).max(2000),
      max_bytes: z.number().int().min(1024).max(1048576).optional(),
      cursor: z.string().max(4000).optional(),
    }),
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const cursorId = `${input.message_id}/${input.attachment_id}`;
      const offset = input.cursor ? decodeCursor(input.cursor, "gmail_attachment", cursorId) : 0;
      if (offset === null) return invalidCursor();
      const tooLarge = () => refuse("attachment_too_large", "This attachment is over 10 MB, too large to download here.");
      return withGmail(caller, async (api) => {
        const listed = renderMessage(await api.getMessage(input.message_id)).attachments.find((item) => item.attachment_id === input.attachment_id);
        if (listed && listed.size > MAX_ATTACHMENT_BYTES) return tooLarge();
        const file = await api.getAttachment(input.message_id, input.attachment_id);
        const bytes = Buffer.from(file.data, "base64url");
        if (bytes.length > MAX_ATTACHMENT_BYTES) return tooLarge();
        if (offset > bytes.length) return invalidCursor();
        const end = Math.min(offset + (input.max_bytes ?? 262144), bytes.length);
        const truncated = end < bytes.length;
        return {
          status: "ok",
          output: {
            filename: listed?.filename ?? null,
            mime_type: listed?.mime_type ?? null,
            size: bytes.length,
            data_base64: bytes.subarray(offset, end).toString("base64"),
            offset,
            truncated,
            next_cursor: truncated ? encodeCursor({ v: 1, kind: "gmail_attachment", id: cursorId, offset: end }) : null,
          },
        };
      });
    },
  });

  return [search, read, attachment];
}
