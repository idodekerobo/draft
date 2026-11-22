import { describeGoogleError, googleRequest, isGoogleRateLimit, type GoogleRequestOptions } from "../google/request";

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly code: "unauthorized" | "forbidden" | "rate_limited" | "not_found" | "request_failed",
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export interface GmailAttachment {
  size: number;
  /** Base64url, as Gmail returns it. */
  data: string;
}

export type GmailMessageFormat = "full" | "metadata" | "minimal";

export interface GmailApi {
  listMessageIds(
    query: string,
    options?: { pageToken?: string; maxResults?: number },
  ): Promise<{ ids: string[]; nextPageToken?: string }>;
  getMessage(id: string, format?: GmailMessageFormat): Promise<GmailMessage>;
  getThread(id: string): Promise<GmailThread>;
  getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment>;
}

export function createGmailApi(accessToken: string, fetchImpl: typeof fetch = fetch, requestOptions: GoogleRequestOptions = {}): GmailApi {
  async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const result = await googleRequest(() => fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } }), requestOptions);
    if (result.ok) return (await result.response.json()) as T;
    const { info, attempts } = result;
    const message = describeGoogleError("Gmail", info, attempts);
    if (info.status === 401) throw new GmailApiError(message, "unauthorized", 401, info.reason);
    if (info.status === 404) throw new GmailApiError(message, "not_found", 404, info.reason);
    if (isGoogleRateLimit(info)) throw new GmailApiError(message, "rate_limited", info.status, info.reason);
    if (info.status === 403) throw new GmailApiError(message, "forbidden", 403, info.reason);
    throw new GmailApiError(message, "request_failed", info.status, info.reason);
  }

  return {
    async listMessageIds(query, options = {}) {
      const size = Math.min(Math.max(Math.trunc(options.maxResults ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
      const json = await get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>("/messages", {
        q: query,
        maxResults: String(size),
        pageToken: options.pageToken,
      });
      return { ids: (json.messages ?? []).map((message) => message.id), nextPageToken: json.nextPageToken };
    },

    getMessage: (id, format = "full") => get(`/messages/${encodeURIComponent(id)}`, { format }),

    async getThread(id) {
      const json = await get<{ id: string; messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(id)}`, { format: "full" });
      return { id: json.id, messages: json.messages ?? [] };
    },

    async getAttachment(messageId, attachmentId) {
      const json = await get<{ size?: number; data?: string }>(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      return { size: json.size ?? 0, data: json.data ?? "" };
    },
  };
}
