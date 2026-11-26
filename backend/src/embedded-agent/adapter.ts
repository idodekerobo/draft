/**
 * The boundary between Draft and the engine that runs an embedded agent's loop inside the backend, as Home's does.
 * Draft owns this interface. One adapter instance serves one agent's durable state. Nothing above it imports an engine.
 * An adapter registers under its 0080 adapter id (for pi, `pi-durable-sdk`); a different engine is a different id.
 */

/** A model an agent can run on, named the way the engine names it. */
export interface EmbeddedModelRef {
  provider: string;
  model: string;
}

/** A person's message, taken in by the agent. `requestId` is stable: the same id never runs twice. */
export interface EmbeddedInput {
  text: string;
  authorUserId: string;
}

/**
 * What the agent does, in the order it did it, in Draft's own words. The projector copies these into
 * `session_events`. `sourceId` is unique and stable, so copying the same event twice leaves one row.
 */
export type EmbeddedEventBody =
  | { kind: "user_message"; requestId: string; text: string; authorUserId: string }
  | { kind: "assistant_text"; text: string; model: EmbeddedModelRef | null }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; name: string; input: unknown }
  | { kind: "tool_result"; toolCallId: string; content: string; isError: boolean }
  /** The agent waits for a person. The identity is the tool call id, which the answer names. */
  | { kind: "permission_request"; toolCallId: string; requestKind: "approval" | "question"; name: string; input: unknown; questions?: ReadonlyArray<{ question: string }> }
  | { kind: "permission_resolved"; toolCallId: string; decision: "allow" | "deny" | "cancelled"; answers?: Readonly<Record<string, string>> }
  /** A turn for one request finished, or stopped. No more events follow it for that request. */
  | { kind: "turn_settled"; requestId: string; outcome: "completed" | "interrupted" | "failed"; reason?: string };

export interface EmbeddedEvent {
  /** Position in the agent's committed history, rising by one. A reader resumes from the last one it saw. */
  seq: number;
  sourceId: string;
  at: string;
  body: EmbeddedEventBody;
}

/** Whether an agent took in a request, or had already. */
export type SubmitReceipt = { requestId: string; duplicate: boolean };

/** How a control ended. A control has a stable id, so a retry returns the first outcome. */
export type ControlOutcome = { controlId: string; applied: boolean; reason?: string };

export interface EmbeddedAnswer {
  /** The `session_inputs` id of the person's answer. The same id applies once. */
  inputId: string;
  decision: "allow" | "deny" | "cancelled";
  answers?: Readonly<Record<string, string>>;
}

/** A piece of reply text on its way to the screen. It is provisional: committed events are the record. */
export interface LiveTextPart {
  requestId: string;
  text: string;
  done: boolean;
}

export interface EmbeddedAgentAdapter {
  /** The 0080 adapter id this adapter is registered under. */
  readonly adapterId: string;

  /** Opens the agent from its saved state, finishing or reattaching work a crash left behind. */
  open(): Promise<void>;
  /** Stops taking work, lets writes finish, and releases the agent. Safe to call twice. */
  close(): Promise<void>;

  /** Takes in a message. A requestId seen before returns its first receipt and starts nothing. */
  submit(input: EmbeddedInput, requestId: string): Promise<SubmitReceipt>;
  /** Stops the turn that is running. Applied false when nothing is running. */
  interrupt(controlId: string): Promise<ControlOutcome>;
  /** Changes the model for the next request. */
  setModel(controlId: string, model: EmbeddedModelRef): Promise<ControlOutcome>;
  /** Answers a waiting approval or question, by the tool call id of its request. */
  answer(toolCallId: string, answer: EmbeddedAnswer): Promise<ControlOutcome>;

  /** Committed events after `afterSeq`, then new ones as they commit, until the adapter closes. */
  events(afterSeq?: number): AsyncIterable<EmbeddedEvent>;
  /** Provisional reply text, for the live view. Nothing in it is kept. */
  liveText(): AsyncIterable<LiveTextPart>;
}

/** Makes the adapter for one agent. The Home host calls this once for each Home it opens. */
export type EmbeddedAgentFactory = (context: { storageScope: string }) => EmbeddedAgentAdapter;
