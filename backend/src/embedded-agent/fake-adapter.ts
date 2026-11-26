import type {
  ControlOutcome,
  EmbeddedAgentAdapter,
  EmbeddedAgentFactory,
  EmbeddedAnswer,
  EmbeddedEvent,
  EmbeddedEventBody,
  EmbeddedInput,
  EmbeddedModelRef,
  LiveTextPart,
  SubmitReceipt,
} from "./adapter";

const DEFAULT_MODEL: EmbeddedModelRef = { provider: "fake", model: "echo-1" };

/**
 * An agent with no engine, for tests of everything above the adapter: the Home session, inputs, projection and the screen.
 * A message echoes back. Four prefixes script other turns: `ask:` waits for an answer, `hold:` runs until interrupted,
 * `fail:` fails the turn, and `reply:` says what follows. Its history is kept in memory, so a new instance starts empty.
 */
export class FakeEmbeddedAgent implements EmbeddedAgentAdapter {
  readonly adapterId = "pi-durable-sdk";

  private readonly log: EmbeddedEvent[] = [];
  private readonly requests = new Map<string, SubmitReceipt>();
  private readonly controls = new Map<string, ControlOutcome>();
  private readonly answered = new Map<string, ControlOutcome>();
  private readonly waiting = new Map<string, string>();
  private active: string | null = null;
  private model = DEFAULT_MODEL;
  private opened = false;
  private closed = false;
  private wakeReaders: Array<() => void> = [];
  private liveReaders = new Set<{ queue: LiveTextPart[]; wake: () => void }>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.wakeReaders.splice(0)) wake();
    for (const reader of this.liveReaders) reader.wake();
  }

  async submit(input: EmbeddedInput, requestId: string): Promise<SubmitReceipt> {
    const earlier = this.requests.get(requestId);
    if (earlier) return { ...earlier, duplicate: true };
    this.assertRunning();
    const receipt = { requestId, duplicate: false };
    this.requests.set(requestId, receipt);

    this.commit(`request:${requestId}`, { kind: "user_message", requestId, text: input.text, authorUserId: input.authorUserId });
    this.runTurn(input.text, requestId);
    return receipt;
  }

  async interrupt(controlId: string): Promise<ControlOutcome> {
    const earlier = this.controls.get(controlId);
    if (earlier) return earlier;
    this.assertRunning();
    const requestId = this.active;
    let outcome: ControlOutcome;
    if (!requestId) {
      outcome = { controlId, applied: false, reason: "idle" };
    } else {
      for (const [toolCallId, waitingRequest] of [...this.waiting]) {
        if (waitingRequest !== requestId) continue;
        this.waiting.delete(toolCallId);
        this.commit(`resolved:${toolCallId}`, { kind: "permission_resolved", toolCallId, decision: "cancelled" });
      }
      this.settle(requestId, "interrupted");
      outcome = { controlId, applied: true };
    }
    this.controls.set(controlId, outcome);
    return outcome;
  }

  async setModel(controlId: string, model: EmbeddedModelRef): Promise<ControlOutcome> {
    const earlier = this.controls.get(controlId);
    if (earlier) return earlier;
    this.assertRunning();
    this.model = model;
    const outcome = { controlId, applied: true };
    this.controls.set(controlId, outcome);
    return outcome;
  }

  async answer(toolCallId: string, answer: EmbeddedAnswer): Promise<ControlOutcome> {
    const earlier = this.answered.get(answer.inputId);
    if (earlier) return earlier;
    this.assertRunning();
    const requestId = this.waiting.get(toolCallId);
    let outcome: ControlOutcome;
    if (!requestId) {
      outcome = { controlId: answer.inputId, applied: false, reason: "not_waiting" };
    } else {
      this.waiting.delete(toolCallId);
      this.commit(`resolved:${toolCallId}`, { kind: "permission_resolved", toolCallId, decision: answer.decision, ...(answer.answers ? { answers: answer.answers } : {}) });
      if (answer.decision === "cancelled") {
        this.settle(requestId, "interrupted", "cancelled");
      } else {
        this.commit(`answer:${toolCallId}`, { kind: "assistant_text", text: `You said ${answer.decision}.`, model: this.model });
        this.settle(requestId, "completed");
      }
      outcome = { controlId: answer.inputId, applied: true };
    }
    this.answered.set(answer.inputId, outcome);
    return outcome;
  }

  async *events(afterSeq = 0): AsyncIterable<EmbeddedEvent> {
    let next = afterSeq;
    while (true) {
      const ready = this.log.filter((event) => event.seq > next);
      for (const event of ready) {
        next = event.seq;
        yield event;
      }
      if (this.closed) return;
      if (this.log.length <= next) await new Promise<void>((resolve) => this.wakeReaders.push(resolve));
    }
  }

  async *liveText(): AsyncIterable<LiveTextPart> {
    const reader = { queue: [] as LiveTextPart[], wake: () => {} };
    this.liveReaders.add(reader);
    try {
      while (true) {
        const part = reader.queue.shift();
        if (part) {
          yield part;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => (reader.wake = resolve));
      }
    } finally {
      this.liveReaders.delete(reader);
    }
  }

  private runTurn(text: string, requestId: string): void {
    this.active = requestId;
    if (text.startsWith("hold:")) return;
    if (text.startsWith("ask:")) {
      const toolCallId = `call-${requestId}`;
      this.waiting.set(toolCallId, requestId);
      this.commit(`request:${toolCallId}`, {
        kind: "permission_request",
        toolCallId,
        requestKind: "question",
        name: "home.ask",
        input: { question: text.slice(4).trim() },
        questions: [{ question: text.slice(4).trim() }],
      });
      return;
    }
    if (text.startsWith("fail:")) {
      this.settle(requestId, "failed", text.slice(5).trim() || "failed");
      return;
    }
    const reply = text.startsWith("reply:") ? text.slice(6).trim() : `echo: ${text}`;
    this.publishLive({ requestId, text: reply, done: false });
    this.publishLive({ requestId, text: reply, done: true });
    this.commit(`reply:${requestId}`, { kind: "assistant_text", text: reply, model: this.model });
    this.settle(requestId, "completed");
  }

  private settle(requestId: string, outcome: "completed" | "interrupted" | "failed", reason?: string): void {
    if (this.active === requestId) this.active = null;
    this.commit(`settled:${requestId}`, { kind: "turn_settled", requestId, outcome, ...(reason ? { reason } : {}) });
  }

  private commit(sourceId: string, body: EmbeddedEventBody): void {
    this.log.push({ seq: this.log.length + 1, sourceId, at: new Date().toISOString(), body });
    for (const wake of this.wakeReaders.splice(0)) wake();
  }

  private publishLive(part: LiveTextPart): void {
    for (const reader of this.liveReaders) {
      reader.queue.push(part);
      reader.wake();
    }
  }

  private assertRunning(): void {
    if (!this.opened) throw new Error("The embedded agent is not open");
    if (this.closed) throw new Error("The embedded agent is closed");
  }
}

export const fakeEmbeddedAgentFactory: EmbeddedAgentFactory = () => new FakeEmbeddedAgent();
