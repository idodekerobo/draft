/** What the backend, the desktop host and the apps agree on for live sessions. */

export const MAX_INPUT_CHARS = 10_000;

/** Events in one page of `/events`. A full page means more may follow. */
export const EVENTS_PAGE_SIZE = 500;

export type LiveSessionErrorCode =
  | "session_not_found"
  | "session_ended"
  | "not_session_owner"
  | "foreign_host"
  | "routine_read_only"
  | "session_cleared"
  | "request_not_found"
  | "request_closed"
  | "already_decided"
  | "queue_full"
  | "message_too_long"
  | "empty_message";

/** Errors after which a host must stop forwarding the session, because a retry cannot help. */
export const HOST_FATAL_CODES: ReadonlySet<string> = new Set<LiveSessionErrorCode>([
  "session_ended",
  "foreign_host",
  "not_session_owner",
  "session_not_found",
]);

/**
 * Answers that mean this login can never reach the session: it belongs to another environment or account.
 * The host stops for that session and keeps its saved state, so the right login can pick it up again.
 */
export const HOST_SUSPEND_CODES: ReadonlySet<string> = new Set(["not_found", "forbidden", "no_team"]);

/** What a host does after a server error: stop for good, pause until the right login, or try again later. */
export function hostErrorAction(code: string): "stop" | "pause" | "retry" {
  if (HOST_FATAL_CODES.has(code)) return "stop";
  return HOST_SUSPEND_CODES.has(code) ? "pause" : "retry";
}

/** Why a queued message waits. */
export type InputBlockReason = "composer_busy" | "permission_prompt" | "question_prompt" | "dialog";

/** Why a message or control input failed or may not have arrived. */
export type InputFailReason =
  | "session_ended"
  | "session_cleared"
  | "pane_unavailable"
  | "delivery_interrupted"
  | "not_submitted"
  | "host_restarted"
  | "request_not_open";

export type InputReason = InputBlockReason | InputFailReason;

/** Line breaks become `\n` and control characters go. A control character in a paste could end it early. */
export function normalizeInputText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

const AUTHOR_PREFIX = /^\[([^\]\n]{1,60}) via Draft\]\s*/;

function cleanAuthorName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\][\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "A teammate";
}

const PASTE_WRAPPER = /<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g;

/** Claude Code wraps a long paste in a `<pasted_content>` tag when it records the turn. Returns the pasted text alone. */
export function stripPasteWrapper(text: string): string {
  return text.includes("<pasted_content") ? text.replace(PASTE_WRAPPER, "$1").trim() : text;
}

/** What Claude sees: the message with its author in front. */
export function deliveredText(authorName: string, text: string): string {
  return `[${cleanAuthorName(authorName)} via Draft] ${text}`;
}

/** Splits an author tag from a prompt that was sent through Draft. The author is null for a typed prompt. */
export function splitAuthor(text: string): { text: string; author: string | null } {
  const match = AUTHOR_PREFIX.exec(text);
  return match ? { text: text.slice(match[0].length), author: match[1]! } : { text, author: null };
}

/** What a person tracks on the presence channel `session:<id>`. The presence key is their user id. */
export interface PresenceMeta {
  name?: string;
}

export const presenceChannel = (sessionId: string) => `session:${sessionId}`;

/** Names of the other people watching, from a channel's presence state. One name per person, in a steady order. */
export function presenceNames(state: Record<string, PresenceMeta[]>, selfId: string): string[] {
  const names: string[] = [];
  for (const [userId, metas] of Object.entries(state)) {
    const name = metas.find((meta) => meta.name?.trim())?.name?.trim();
    if (userId !== selfId && name) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}
