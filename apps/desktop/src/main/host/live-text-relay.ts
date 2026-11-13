import type { LiveTextChunk } from "draft-core/live-sessions";

const FLUSH_MS = 30;
const MAX_CHUNK_CHARS = 8000;
const MAX_OPEN = 20;

interface Open {
  index: number;
  unsent: string;
  timer: unknown | null;
}

export interface LiveTextRelayDeps {
  send: (chunk: LiveTextChunk) => void;
  enabled?: () => boolean;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Gathers the text of each message the agent writes and sends it to viewers in short chunks. Nothing is stored. */
export class LiveTextRelay {
  private readonly open = new Map<string, Open>();
  private readonly enabled: () => boolean;
  private readonly schedule: (run: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly deps: LiveTextRelayDeps) {
    this.enabled = deps.enabled ?? (() => process.env.LIVE_TEXT !== "off");
    this.schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms));
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  push(messageId: string, text: string, final: boolean): void {
    if (!this.enabled()) return;
    let message = this.open.get(messageId);
    if (!message) {
      if (text === "") return;
      message = { index: 0, unsent: "", timer: null };
      this.open.set(messageId, message);
      if (this.open.size > MAX_OPEN) this.forget(this.open.keys().next().value!);
    }
    message.unsent += text;
    if (final) return this.flush(messageId, message, true);
    if (message.unsent.length >= MAX_CHUNK_CHARS) return this.flush(messageId, message, false);
    if (message.timer === null && message.unsent !== "") {
      message.timer = this.schedule(() => this.flush(messageId, message!, false), FLUSH_MS);
    }
  }

  stop(): void {
    for (const message of this.open.values()) this.clearTimer(message);
    this.open.clear();
  }

  private flush(messageId: string, message: Open, final: boolean): void {
    this.clearTimer(message);
    const parts = split(message.unsent);
    message.unsent = "";
    if (parts.length === 0 && final && message.index > 0) parts.push("");
    parts.forEach((text, i) => {
      this.deps.send({ messageId, index: message.index++, text, final: final && i === parts.length - 1 });
    });
    if (final) this.open.delete(messageId);
  }

  private forget(messageId: string): void {
    const message = this.open.get(messageId);
    if (message) this.clearTimer(message);
    this.open.delete(messageId);
  }

  private clearTimer(message: Open): void {
    if (message.timer !== null) this.cancel(message.timer);
    message.timer = null;
  }
}

function split(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    // Do not cut a surrogate pair in half.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
