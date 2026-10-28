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
  last_event_at: string | null;
  last_seq: number;
  /** Permission requests waiting for an answer. */
  open_approval_count?: number;
  /** True when the caller owns the session. */
  mine?: boolean;
  /** The Claude Code version the host runs. */
  harness_version?: string | null;
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
}

export interface LiveSessionEvent {
  seq: number;
  source_id: string;
  kind: LiveSessionEventKind;
  payload: LiveSessionEventPayload;
  created_at: string;
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
  sendMessage(sessionId: string, text: string): Promise<void>;
  actOnInput(sessionId: string, inputId: string, action: "resend" | "dismiss"): Promise<void>;
  decideApproval(sessionId: string, requestId: string, decision: "allow" | "deny"): Promise<ApprovalResult>;
  stop(sessionId: string): Promise<void>;
  /** Calls `onChange` with the names of the other people watching. Returns the stop function. Absent where presence is not available. */
  watchPresence?(sessionId: string, viewer: LiveSessionViewer, onChange: (names: string[]) => void): () => void;
}

/** The workspace has the feature switched off. */
export class LiveSessionsDisabledError extends Error {
  constructor() {
    super("live_sessions_disabled");
  }
}

/** The session does not exist, or the viewer's team cannot see it. The two look the same on purpose. */
export class SessionNotFoundError extends Error {
  constructor() {
    super("session_not_found");
  }
}
