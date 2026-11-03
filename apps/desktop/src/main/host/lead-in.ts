import type { HostEvent } from "./approvals";

/** A completed message counts as the lead-in of a request that opens within this long after it. */
const WINDOW_MS = 15_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_OPEN_MESSAGES = 20;

export interface MessagePayload {
  message_id?: unknown;
  index?: unknown;
  final?: unknown;
  delta?: unknown;
}

/**
 * Claude writes a message to its transcript only after the tool call at its end resolves, so a question or
 * approval would show in Draft with no context. Claude's MessageDisplay hook streams the text while it waits.
 * This posts a message that ends in a request, once, as an early copy that the stream drops when the
 * transcript's own copy arrives.
 */
export class LeadInRelay {
  private readonly parts = new Map<string, string[]>();
  private recent: { id: string; text: string; at: number; posted: boolean } | null = null;
  private open = 0;

  constructor(
    private readonly post: (events: HostEvent[]) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** One streamed chunk. Chunks of a message arrive in order. */
  message(payload: MessagePayload): void {
    const { message_id: id, index, final, delta } = payload;
    if (typeof id !== "string" || !id || typeof delta !== "string") return;
    const parts = this.parts.get(id) ?? [];
    parts[typeof index === "number" ? index : parts.length] = delta;
    this.parts.set(id, parts);
    if (this.parts.size > MAX_OPEN_MESSAGES) this.parts.delete(this.parts.keys().next().value!);
    if (final !== true) return;

    this.parts.delete(id);
    const text = parts.join("").trim().slice(0, MAX_TEXT_CHARS);
    if (!text) return;
    this.recent = { id, text, at: this.now(), posted: false };
    if (this.open > 0) this.flush();
  }

  requestOpened(): void {
    this.open++;
    if (this.recent && !this.recent.posted && this.now() - this.recent.at <= WINDOW_MS) this.flush();
  }

  requestClosed(): void {
    this.open = Math.max(0, this.open - 1);
  }

  private flush(): void {
    const message = this.recent;
    if (!message || message.posted) return;
    message.posted = true;
    this.post([{ sourceId: `lead:${message.id}`, kind: "assistant_text", payload: { text: message.text, preview: true } }]).catch((error) =>
      console.error("[live-session] could not post a lead-in", error),
    );
  }
}
