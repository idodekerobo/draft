/** Joins a topic and calls `onEvent` for each signal. Tells it `catch-up` each time the channel joins. Returns the leave function. */
export type SignalSource = (topic: string, onEvent: (event: string) => void) => () => void;
export type SignalListener = (event: string) => void;

interface Held {
  leave: () => void;
  listeners: Set<SignalListener>;
}

/**
 * Owns the signal subscriptions of the main process. Several listeners of one topic share one channel.
 * The window gives the whole list of topics it wants each time that list changes; the manager joins
 * what is new and leaves what is gone, and drops the whole list when the window is replaced.
 */
export class RealtimeManager {
  private readonly held = new Map<string, Held>();
  private windowStops = new Map<string, () => void>();

  constructor(
    private readonly source: SignalSource,
    private readonly sendToWindow: (topic: string, event: string) => void,
  ) {}

  watch(topic: string, listener: SignalListener): () => void {
    let entry = this.held.get(topic);
    if (!entry) {
      const created: Held = { leave: () => {}, listeners: new Set() };
      this.held.set(topic, created);
      created.leave = this.source(topic, (event) => created.listeners.forEach((l) => l(event)));
      entry = created;
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || this.held.get(topic) !== entry) return;
      this.held.delete(topic);
      entry.leave();
    };
  }

  setWindowTopics(topics: string[]): void {
    const wanted = new Set(topics);
    for (const [topic, stop] of this.windowStops) {
      if (wanted.has(topic)) continue;
      stop();
      this.windowStops.delete(topic);
    }
    for (const topic of wanted) {
      if (this.windowStops.has(topic)) continue;
      this.windowStops.set(topic, this.watch(topic, (event) => this.sendToWindow(topic, event)));
    }
  }

  clearWindow(): void {
    this.setWindowTopics([]);
  }

  size(): number {
    return this.held.size;
  }
}
