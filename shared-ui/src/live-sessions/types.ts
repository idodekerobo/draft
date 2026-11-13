import type { LiveTextChunk } from "draft-core/live-sessions";

export type LiveSessionStatus = "starting" | "live" | "host_offline" | "ended";

export interface LiveSession {
  id: string;
  owner_user_id: string;
  owner_name: string | null;
  /** A routine run is read-only: nobody can message it. */
  session_type?: "interactive" | "routine";
  title: string | null;
  folder_name: string | null;
  host_name: string | null;
  status: LiveSessionStatus;
  started_at: string;
  ended_at: string | null;
  /** Why it ended, such as exited, ended_by_owner or cleared. */
  end_reason?: string | null;
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
  agent_message?: { from: string; type: "idle" | "message"; color?: string; summary?: string; text: string };
  /** session_note: who pressed Stop on a running turn. */
  interrupted_by?: { id: string; name: string };
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

/** An input as the composer shows it. "sending" exists only on this device, until the server list holds the message. */
export type ComposerInput = Omit<LiveSessionInput, "state"> & {
  state: LiveSessionInputState | "sending";
  /** Holds steady from the local send to the server copy, for the bubble in the stream. */
  key?: string;
};

export type ApprovalResult =
  | { ok: true }
  | { ok: false; error: "already_decided"; byName: string | null }
  | { ok: false; error: "request_closed" | "session_ended" | "failed" };

/** Each app implements this over its own transport. */
export interface LiveSessionsApi {
  listSessions(): Promise<LiveSession[]>;
  fetchEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage>;
  /** Returns the created input when the transport gives it back; otherwise the caller refetches. */
  sendMessage(sessionId: string, text: string): Promise<LiveSessionInput | void>;
  actOnInput(sessionId: string, inputId: string, action: "resend" | "dismiss" | "steer" | "cancel"): Promise<void>;
  decideApproval(sessionId: string, requestId: string, response: ApprovalResponse): Promise<ApprovalResult>;
  /** `withdrawn` holds the caller's own messages that Claude had not taken. Stop pulled them back. */
  stop(sessionId: string, options?: { keepQueued?: boolean }): Promise<{ withdrawn: string[] }>;
  /** Asks the host to switch the session to these modes. It reports the mode it reaches, which the next poll shows. */
  setMode(sessionId: string, change: { permissionMode?: string; approvalMode?: string }): Promise<void>;
  /** Starts an ended session again on the owner's computer. Only the desktop app offers it. Throws with a message to show. */
  resume?(sessionId: string): Promise<void>;
  /** Calls `onChange` with the names of the other people watching. Returns the stop function. Absent where presence is not available. */
  watchPresence?(sessionId: string, viewer: LiveSessionViewer, onChange: (names: string[]) => void): () => void;
  /**
   * Calls `onSignal` with the event name when the server says something changed on a topic. It also calls it with
   * `catch-up` when the connection is joined or comes back, so nothing is missed. Returns the stop function.
   * Absent where Realtime is not available; the app then relies on its slow safety polls alone.
   */
  watchSignals?(topic: string, onSignal: (event: string) => void): () => void;
  /** Calls `onChunk` with each piece of text the agent is writing. Nothing is stored; a viewer who joins late sees only what comes after. Returns the stop function. Absent where Realtime is not available. */
  watchLiveText?(sessionId: string, onChunk: (chunk: LiveTextChunk) => void): () => void;
  /** Calls `onChange` with whether every watched topic is joined, now and at each change. Returns the stop function. */
  watchConnection?(onChange: (connected: boolean) => void): () => void;
}

/** The session does not exist, or the viewer's team cannot see it. The two look the same on purpose. */
export class SessionNotFoundError extends Error {
  constructor() {
    super("session_not_found");
  }
}
