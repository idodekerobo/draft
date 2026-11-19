import type { ApprovalResponse, LiveSession, LiveSessionEventsPage, LiveSessionInput, LiveSessionInputState, LiveSessionViewer, LiveTextChunk } from "draft-core/live-sessions";

export type {
  AnswerValue,
  ApprovalKind,
  ApprovalResponse,
  LiveQuestion,
  LiveQuestionOption,
  LiveSession,
  LiveSessionEvent,
  LiveSessionEventKind,
  LiveSessionEventPayload,
  LiveSessionEventsPage,
  LiveSessionInput,
  LiveSessionInputState,
  LiveSessionLink,
  LiveSessionStatus,
  LiveSessionViewer,
} from "draft-core/live-sessions";

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
  fetchView?(sessionId: string, query: import("draft-core/live-sessions").SessionViewQuery): Promise<import("draft-core/live-sessions").SessionViewResponse>;
  fetchEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage>;
  /** Returns the created input when the transport gives it back; otherwise the caller refetches. */
  sendMessage(sessionId: string, text: string): Promise<LiveSessionInput | void>;
  actOnInput(sessionId: string, inputId: string, action: "resend" | "dismiss" | "steer" | "cancel"): Promise<void>;
  decideApproval(sessionId: string, requestId: string, response: ApprovalResponse): Promise<ApprovalResult>;
  /** `withdrawn` holds the caller's own messages that Claude had not taken. Stop pulled them back. */
  stop(sessionId: string, options?: { keepQueued?: boolean }): Promise<{ withdrawn: string[] }>;
  /** Asks the host to switch the session to these modes. It reports the mode it reaches, which the next poll shows. */
  setMode(sessionId: string, change: { permissionMode?: string; approvalMode?: string; model?: string | null; reasoningEffort?: string | null }): Promise<void>;
  /** Starts an ended session again on the owner's computer. Only the desktop app offers it. Throws with a message to show. */
  resume?(sessionId: string): Promise<void>;
  /** Hides the owner's session from everyone in Draft. A live session ends first. Absent where the app cannot delete. Throws on failure. */
  deleteSession?(sessionId: string): Promise<void>;
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

export type { SessionViewQuery, SessionViewResponse, SessionTranscriptPage, SessionAgentSummary, SessionViewSnapshot } from "draft-core/live-sessions";
