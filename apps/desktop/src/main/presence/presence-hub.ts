export interface PresenceViewer {
  id: string;
  name: string;
}

/** Joins the channel and reports the other watchers. Returns the function that leaves it. */
export type ConnectPresence = (sessionId: string, viewer: PresenceViewer, onNames: (names: string[]) => void) => () => void;

const IDLE_MS = 20_000;
const SWEEP_MS = 10_000;

interface Entry {
  names: string[];
  lastPoll: number;
  leave: () => void;
}

/**
 * The window asks for presence by polling. The hub joins a session's channel on the first ask and leaves it
 * when the window stops asking, so a closed view does not keep a connection open.
 */
export class PresenceHub {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly connect: ConnectPresence,
    private readonly now: () => number = Date.now,
  ) {}

  poll(sessionId: string, viewer: PresenceViewer): string[] {
    const key = `${sessionId}:${viewer.id}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = { names: [], lastPoll: this.now(), leave: () => {} };
      created.leave = this.connect(sessionId, viewer, (names) => void (created.names = names));
      this.entries.set(key, created);
      entry = created;
      this.timer ??= setInterval(() => this.sweep(), SWEEP_MS);
    }
    entry.lastPoll = this.now();
    return entry.names;
  }

  sweep(): void {
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.lastPoll < IDLE_MS) continue;
      entry.leave();
      this.entries.delete(key);
    }
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  size(): number {
    return this.entries.size;
  }
}
