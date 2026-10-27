/** What the backend, the desktop host and the apps agree on for live sessions. */

export const MAX_INPUT_CHARS = 10_000;

/** Events in one page of `/events`. A full page means more may follow. */
export const EVENTS_PAGE_SIZE = 500;

export type LiveSessionErrorCode =
  | "live_sessions_disabled"
  | "session_not_found"
  | "session_ended"
  | "not_session_owner"
  | "foreign_host"
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
  "live_sessions_disabled",
]);

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

/** What Claude sees: the message with its author in front. */
export function deliveredText(authorName: string, text: string): string {
  return `[${cleanAuthorName(authorName)} via Draft] ${text}`;
}

/** Splits an author tag from a prompt that was sent through Draft. The author is null for a typed prompt. */
export function splitAuthor(text: string): { text: string; author: string | null } {
  const match = AUTHOR_PREFIX.exec(text);
  return match ? { text: text.slice(match[0].length), author: match[1]! } : { text, author: null };
}

/** Claude Code releases the live-session host was tested with: this major and minor. */
export const TESTED_CLAUDE_VERSION = { major: 2, minor: 1 } as const;

/** The version number in the output of `claude --version`. */
export function parseClaudeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

/** True or false for a known version, null when it is not known. */
export function isTestedClaudeVersion(version: string | null | undefined): boolean | null {
  const parsed = version ? parseClaudeVersion(version) : null;
  if (!parsed) return null;
  const [major, minor] = parsed.split(".").map(Number);
  return major === TESTED_CLAUDE_VERSION.major && minor === TESTED_CLAUDE_VERSION.minor;
}

/** Harnesses a session can run. Claude Code only for now. */
export const LIVE_SESSION_HARNESSES = [{ id: "claude", label: "Claude Code" }] as const;

/** Models a person can pick. `alias` goes to `claude --model`; null leaves the choice to Claude's own setting. */
export const LIVE_SESSION_MODELS: ReadonlyArray<{ alias: string | null; label: string }> = [
  { alias: null, label: "Default" },
  { alias: "fable", label: "Fable" },
  { alias: "opus", label: "Opus" },
  { alias: "sonnet", label: "Sonnet" },
  { alias: "haiku", label: "Haiku" },
];

export const isKnownModelAlias = (alias: string | null | undefined): boolean =>
  LIVE_SESSION_MODELS.some((model) => model.alias === (alias ?? null));
