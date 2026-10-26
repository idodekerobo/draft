export type LiveSessionStatus = "starting" | "live" | "host_offline" | "ended";

export interface LiveSession {
  id: string;
  owner_user_id: string;
  owner_name: string | null;
  title: string | null;
  folder_name: string | null;
  host_name: string | null;
  status: LiveSessionStatus;
  started_at: string;
  ended_at: string | null;
  last_event_at: string | null;
  last_seq: number;
}

export type LiveSessionEventKind = "user_message" | "assistant_text" | "tool_use" | "tool_result" | "thinking" | "session_note";

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
}

export interface LiveSessionEvent {
  seq: number;
  source_id: string;
  kind: LiveSessionEventKind;
  payload: LiveSessionEventPayload;
  created_at: string;
}

export interface LiveSessionEventsPage {
  session: LiveSession;
  events: LiveSessionEvent[];
}

/** Each app implements this over its own transport. */
export interface LiveSessionsApi {
  listSessions(): Promise<LiveSession[]>;
  fetchEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage>;
}

/** The workspace has the feature switched off. */
export class LiveSessionsDisabledError extends Error {
  constructor() {
    super("live_sessions_disabled");
  }
}
