import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCaller } from "draft-core/tools";
import { googleOAuthSettings, type GoogleOAuthSettings } from "../../../config";
import { gmailAccessFor } from "../../../ingestion/gmail/access";
import { GmailApiError, type GmailApi } from "../../../ingestion/gmail/api";
import { renderMessage } from "../../../ingestion/gmail/render";
import { refuse, type ToolHandlerResult } from "../tool-registry";
import type { ConnectionAdapter, ProviderAction, ReadInput, SearchInput } from "./types";

export interface GmailDeps {
  fetch?: typeof fetch;
  settings?: () => GoogleOAuthSettings | null;
}

const METADATA_CONCURRENCY = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_BYTES = 32768;
const DEFAULT_ATTACHMENT_BYTES = 262144;

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

const invalidCursor = () => refuse("invalid_cursor", "That cursor isn't one this tool returned for this id. Pass nextCursor from the previous page.");

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

const GMAIL_ACTIONS: ReadonlyArray<ProviderAction> = [
  {
    verb: "search",
    description: "Search the mailbox of the person you work for with Gmail search syntax (from:, subject:, has:attachment). cal meeting needs both words, \"cal meeting\" the phrase. Newest first. Nothing is stored.",
    fields: { query: "Gmail search syntax (required)", since: "ISO date, added as after: (optional)", until: "ISO date, added as before: (optional)", limit: "1 to 50 (optional, default 20)", cursor: "nextCursor of the previous page (optional)" },
  },
  {
    verb: "read",
    description: "Read one message or a whole thread found with search, as plain text cut to maxBytes. Pass nextCursor back as cursor with the same id for the rest. With attachmentId it downloads that attachment as base64.",
    fields: { messageId: "one message (or threadId)", threadId: "a whole thread (or messageId)", attachmentId: "with messageId: an attachment the message lists", maxBytes: "bytes to return at a time (optional)", cursor: "nextCursor of the previous page (optional)" },
  },
];

/** Gmail as a connection adapter: live search and reading of the signed-in person's own mailbox. */
export function createGmailAdapter(client: SupabaseClient, deps: GmailDeps = {}): ConnectionAdapter {
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

  async function search(caller: ToolCaller, input: SearchInput): Promise<ToolHandlerResult> {
    const terms = [input.query];
    for (const [operator, value] of [["after", input.since], ["before", input.until]] as const) {
      if (value === undefined) continue;
      const date = gmailDate(value);
      if (!date) return refuse("invalid_input", `${operator === "after" ? "since" : "until"} must be an ISO date.`);
      terms.push(`${operator}:${date}`);
    }
    return withGmail(caller, async (api) => {
      const page = await api.listMessageIds(terms.join(" "), { pageToken: input.cursor, maxResults: input.limit ?? 20 });
      const results = await mapLimit(page.ids, METADATA_CONCURRENCY, async (id) => {
        const rendered = renderMessage(await api.getMessage(id, "metadata"));
        return { id: rendered.id, threadId: rendered.thread_id, title: rendered.subject, from: rendered.from, date: rendered.date, snippet: rendered.snippet };
      });
      return { status: "ok", output: { provider: "gmail", results, nextCursor: page.nextPageToken ?? null } };
    });
  }

  async function readAttachment(caller: ToolCaller, messageId: string, attachmentId: string, input: ReadInput): Promise<ToolHandlerResult> {
    const cursorId = `${messageId}/${attachmentId}`;
    const offset = input.cursor ? decodeCursor(input.cursor, "gmail_attachment", cursorId) : 0;
    if (offset === null) return invalidCursor();
    const tooLarge = () => refuse("attachment_too_large", "This attachment is over 10 MB, too large to download here.");
    return withGmail(caller, async (api) => {
      const listed = renderMessage(await api.getMessage(messageId)).attachments.find((item) => item.attachment_id === attachmentId);
      if (listed && listed.size > MAX_ATTACHMENT_BYTES) return tooLarge();
      const file = await api.getAttachment(messageId, attachmentId);
      const bytes = Buffer.from(file.data, "base64url");
      if (bytes.length > MAX_ATTACHMENT_BYTES) return tooLarge();
      if (offset > bytes.length) return invalidCursor();
      const end = Math.min(offset + (input.maxBytes ?? DEFAULT_ATTACHMENT_BYTES), bytes.length);
      const truncated = end < bytes.length;
      return {
        status: "ok",
        output: {
          provider: "gmail",
          filename: listed?.filename ?? null,
          mimeType: listed?.mime_type ?? null,
          size: bytes.length,
          dataBase64: bytes.subarray(offset, end).toString("base64"),
          offset,
          truncated,
          nextCursor: truncated ? encodeCursor({ v: 1, kind: "gmail_attachment", id: cursorId, offset: end }) : null,
        },
      };
    });
  }

  async function readMessages(caller: ToolCaller, input: ReadInput): Promise<ToolHandlerResult> {
    const id = input.messageId ?? input.threadId;
    if (!id || (input.messageId && input.threadId)) return refuse("invalid_input", "Gmail read needs exactly one of messageId or threadId.");
    const cursorId = input.messageId ? `message:${id}` : `thread:${id}`;
    const offset = input.cursor ? decodeCursor(input.cursor, "gmail_read", cursorId) : 0;
    if (offset === null) return invalidCursor();
    const budget = input.maxBytes ?? DEFAULT_READ_BYTES;
    return withGmail(caller, async (api) => {
      const raw = input.messageId ? [await api.getMessage(id)] : (await api.getThread(id)).messages;
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
      const nextCursor = truncatedAt === null ? null : encodeCursor({ v: 1, kind: "gmail_read", id: cursorId, offset: truncatedAt });
      return { status: "ok", output: { provider: "gmail", messages, truncated: truncatedAt !== null, nextCursor } };
    });
  }

  return {
    provider: "gmail",
    row: "google",
    notConnectedMessage: "Google is not connected. A person can connect it with connections.connect.",
    actions: GMAIL_ACTIONS,
    search: ({ caller }, input) => search(caller, input),
    read: ({ caller }, input) => {
      if (input.attachmentId) {
        return input.messageId ? readAttachment(caller, input.messageId, input.attachmentId, input) : Promise.resolve(refuse("invalid_input", "An attachment needs messageId as well as attachmentId."));
      }
      return readMessages(caller, input);
    },
    // The query is the person's own mail search, so the audit row never keeps it.
    audit: (verb, input) => ({
      provider: "gmail",
      ...(verb === "search" ? { query: "[redacted]", since: input.since, until: input.until, limit: input.limit } : {}),
      ...(verb === "read" ? { messageId: input.messageId, threadId: input.threadId, attachmentId: input.attachmentId, maxBytes: input.maxBytes } : {}),
      cursor: redactCursor(input.cursor as string | undefined),
    }),
  };
}
