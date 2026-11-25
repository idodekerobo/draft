import type { SessionFailure } from "./session-failure";
/** What the backend, the desktop host and the apps agree on for live sessions. */

export type SessionEventKind =
  | "user_message"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "session_note"
  | "permission_request"
  | "permission_resolved";

export const MAX_INPUT_CHARS = 10_000;

/** Events in one page of `/events`. A full page means more may follow. */
export const EVENTS_PAGE_SIZE = 500;

export type LiveSessionErrorCode =
  | "session_not_found"
  | "session_ended"
  | "session_sleeping"
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
  | "request_not_open"
  | "mode_failed";

export type InputReason = InputBlockReason | InputFailReason;

/** A prompt in the terminal is what holds the message back. */
const PROMPT_BLOCK_REASONS: ReadonlySet<string> = new Set<InputBlockReason>(["dialog", "permission_prompt", "question_prompt"]);
export const isPromptBlock = (reason: string | null | undefined): boolean => reason != null && PROMPT_BLOCK_REASONS.has(reason);

/** The longest reason or feedback a decision carries. */
export const MAX_DECISION_MESSAGE_CHARS = 2000;

/** Line breaks become `\n` and control characters go. A control character in a paste could end it early. */
export function normalizeInputText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

const AUTHOR_PREFIX = /^\[([^\]\n]{1,60}) via Draft(?: #([0-9a-f]{8}))?\]\s*/;

function cleanAuthorName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\][\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "A teammate";
}

const PASTE_WRAPPER = /<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g;

/** Claude Code wraps a long paste in a `<pasted_content>` tag when it records the turn. Returns the pasted text alone. */
export function stripPasteWrapper(text: string): string {
  return text.includes("<pasted_content") ? text.replace(PASTE_WRAPPER, "$1").trim() : text;
}

/** What Claude sees: the message with its author in front. With an input id, the tag carries its first 8 hex characters. */
export function deliveredText(authorName: string, text: string, inputId?: string): string {
  const ref = inputId?.slice(0, 8).toLowerCase();
  const tag = ref && /^[0-9a-f]{8}$/.test(ref) ? ` #${ref}` : "";
  return `[${cleanAuthorName(authorName)} via Draft${tag}] ${text}`;
}

/**
 * Splits an author tag from a prompt that was sent through Draft. The author is null for a typed prompt.
 * `inputRef` is the start of the id of the input that carried it, null for a tag without one.
 */
export function splitAuthor(text: string): { text: string; author: string | null; inputRef: string | null } {
  const match = AUTHOR_PREFIX.exec(text);
  return match ? { text: text.slice(match[0].length), author: match[1]!, inputRef: match[2] ?? null } : { text, author: null, inputRef: null };
}

/** What a person tracks on the presence channel `session:<id>`. The presence key is their user id. */
export interface PresenceMeta {
  name?: string;
}

export const presenceChannel = (sessionId: string) => `session:${sessionId}`;

/** Topics the database sends signals on. They start with "signals:" because presence owns `session:<id>`. */
export const sessionSignalTopic = (sessionId: string) => `signals:session:${sessionId}`;
export const workspaceSignalTopic = (workspaceId: string) => `signals:workspace:${workspaceId}`;

/** The topic a session's host sends live text on, while the agent writes a message. Nothing on it is stored. */
export const liveTextTopic = (sessionId: string) => `live:session:${sessionId}`;
export const LIVE_TEXT_EVENT = "text";

/** A piece of a message the agent is writing. Pieces of one message have rising `index`; `final` ends it. */
export interface LiveTextChunk {
  messageId: string;
  index: number;
  text: string;
  final: boolean;
}

export function isLiveTextChunk(value: unknown): value is LiveTextChunk {
  const v = value as Partial<LiveTextChunk> | null;
  return !!v && typeof v.messageId === "string" && v.messageId !== "" && typeof v.index === "number" && typeof v.text === "string" && typeof v.final === "boolean";
}

/** Event names of a signal. `catchUp` is never sent by the server: apps make it when a connection joins or returns. */
export const SIGNAL_EVENTS = {
  catchUp: "catch-up",
  inputs: "inputs",
  sessions: "sessions",
  context: "context",
} as const;

/** Names of the other people watching, from a channel's presence state. One name per person, in a steady order. */
export function presenceNames(state: Record<string, PresenceMeta[]>, selfId: string): string[] {
  const names: string[] = [];
  for (const [userId, metas] of Object.entries(state)) {
    const name = metas.find((meta) => meta.name?.trim())?.name?.trim();
    if (userId !== selfId && name) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export type LiveSessionStatus = "starting" | "live" | "host_offline" | "sleeping" | "ended";

export interface LiveSession {
  id: string;
  owner_user_id: string;
  owner_name: string | null;
  /** A routine run is read-only: nobody can message it. */
  session_type?: "interactive" | "routine";
  /** Where it runs: an already-registered host such as the owner's computer, a Draft sandbox, or Draft's backend. */
  execution_target?: "host" | "sandbox" | "backend";
  /** The adapter that runs the harness, such as `claude-terminal`. */
  adapter_id?: string;
  /** When the session's files were last backed up. Cloud sessions only; null until the first backup. */
  raw_uploaded_at?: string | null;
  title: string | null;
  folder_name: string | null;
  host_name: string | null;
  status: LiveSessionStatus;
  started_at: string;
  ended_at: string | null;
  /** Why it ended, such as exited, ended_by_owner or cleared. */
  end_reason?: string | null;
  resume_request_id?: string | null;
  last_failure?: SessionFailure | null;
  last_event_at: string | null;
  last_seq: number;
  /** Permission requests waiting for an answer. */
  open_approval_count?: number;
  /** True when the caller owns the session. */
  mine?: boolean;
  /** The agent that runs the session, such as claude or codex. Rows from before harnesses were recorded may lack it. */
  harness?: string;
  /** Alias the harness CLI was started with; null for its own default. */
  model?: string | null;
  /** Plain text such as "low" or "xhigh"; null for the harness's own setting. */
  reasoning_effort?: string | null;
  /** The version of the harness CLI the host runs. */
  harness_version?: string | null;
  /** Claude: manual (default), acceptEdits, plan or auto. Codex: default or plan. Null until the host reports it. */
  permission_mode?: string | null;
  /** Codex only: ask-for-approval, approve-for-me or full-access. */
  approval_mode?: string | null;
  /** The session this one continues after a /clear. */
  previous_session?: LiveSessionLink | null;
  /** The session that continued this one after a /clear. */
  next_session?: LiveSessionLink | null;
}

export interface LiveSessionLink {
  id: string;
  title: string | null;
  folder_name: string | null;
}

export type LiveSessionEventKind = "user_message" | "assistant_text" | "tool_use" | "tool_result" | "thinking" | "session_note" | "permission_request" | "permission_resolved";

/** What a request waits for: an allow or deny, answers to questions, or a decision on a plan. */
export type ApprovalKind = "approval" | "question" | "plan";

export interface LiveQuestionOption {
  label: string;
  description?: string;
}

export interface LiveQuestion {
  /** The key the answer goes under. */
  key: string;
  header?: string;
  question: string;
  options: LiveQuestionOption[];
  multiSelect: boolean;
  isOther: boolean;
  isSecret: boolean;
}

export type AnswerValue = string | string[];

/** A person's answer to an open request. */
export interface ApprovalResponse {
  decision: "allow" | "deny";
  /** Answers to a question request, by question key. */
  answers?: Record<string, AnswerValue>;
  /** Why a request was denied, or what to change in a plan. */
  message?: string;
  scope?: "once" | "session";
  /** For a plan approval: the mode the session switches to. */
  permissionMode?: "auto" | "default";
}

export interface LiveSessionEventPayload {
  text?: string;
  timestamp?: string | null;
  /** Set on events from a sub-agent transcript. */
  agent_id?: string;
  truncated?: boolean;
  tool_use_id?: string | null;
  name?: string;
  input?: unknown;
  input_truncated?: boolean;
  content?: string;
  is_error?: boolean;
  agent_result?: { id: string; async: boolean; model: string | null };
  agent_lifecycle?: { id: string; state: "working" | "idle"; isError: boolean };
  /** permission_request and permission_resolved */
  requestId?: string;
  /** permission_resolved: decided, answered_locally, hook_gone or expired. */
  reason?: string;
  decision?: "allow" | "deny";
  by_name?: string;
  /** permission_request */
  kind?: ApprovalKind;
  questions?: LiveQuestion[];
  plan?: string;
  /** assistant_text: an early copy of a message that ends in a request. The transcript sends the real one later. */
  preview?: boolean;
  /** The harness can allow this for the rest of the session. */
  allowSession?: boolean;
  /** permission_request for a plan: the mode the session was in. permission_resolved: the mode the approval switched to. */
  permissionMode?: string;
  /** permission_resolved: what the decider answered or wrote. */
  answers?: Record<string, AnswerValue>;
  message?: string;
  /** session_note: a message from another agent in the session's team. Never a person. */
  agent_message?: { from: string; type: "idle" | "message" | "handback"; color?: string; summary?: string; text: string };
  /** session_note: who pressed Stop on a running turn. */
  interrupted_by?: { id: string; name: string };
  failure?: SessionFailure;
}

export interface LiveSessionEvent {
  seq: number;
  source_id: string;
  kind: LiveSessionEventKind;
  payload: LiveSessionEventPayload;
  created_at: string;
  /** On a user_message sent through Draft: who sent it. Null when it is unknown or typed in the terminal. */
  author_user_id?: string | null;
  /** The sender's current display name, when author_user_id is known. */
  author_name?: string | null;
}

export interface LiveSessionViewer {
  id: string;
  name: string;
}

export interface LiveSessionEventsPage {
  session: LiveSession;
  /** The person asking. */
  viewer: LiveSessionViewer;
  events: LiveSessionEvent[];
  /** Messages that Claude has not yet taken. */
  inputs: LiveSessionInput[];
  /** Who sent each of the latest 20 messages through the app. Absent on older servers. */
  authors?: Array<{ seq: number; author_user_id: string; author_name: string | null }>;
}

export type LiveSessionInputState = "queued" | "delivering" | "failed" | "uncertain";

/** A message someone sent that Claude has not yet taken. */
export interface LiveSessionInput {
  id: string;
  author_user_id: string;
  author_name: string;
  text: string;
  state: LiveSessionInputState;
  /** Why it waits (queued) or why it failed. */
  reason: string | null;
  created_at: string;
  updated_at: string;
  /** The caller wrote it. */
  mine: boolean;
}

export interface SessionViewQuery {
  agentId?: string;
  before?: number;
  after?: number;
  around?: number;
  through?: number;
  limit?: number;
  state?: boolean;
}

export interface SessionTranscriptPage {
  agentId: string | null;
  events: LiveSessionEvent[];
  dependencies: LiveSessionEvent[];
  before: number | null;
  after: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  through: number;
  readThrough: number;
}

export interface SessionAgentSummary {
  async: boolean;
  key: string;
  agentId: string | null;
  hostSeq: number | null;
  firstSeq: number;
  lastSeq: number;
  name: string | null;
  description: string | null;
  model: string | null;
  steps: number;
  isError: boolean;
  state: "working" | "idle";
}

export interface SessionViewSnapshot {
  session: LiveSession;
  viewer: LiveSessionViewer;
  inputs: LiveSessionInput[];
  approvals: LiveSessionEvent[];
  agents: SessionAgentSummary[];
  authors?: LiveSessionEventsPage["authors"];
}

export interface SessionViewResponse {
  page: SessionTranscriptPage;
  snapshot?: SessionViewSnapshot;
}
