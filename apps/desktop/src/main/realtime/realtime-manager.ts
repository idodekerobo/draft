import { SIGNAL_EVENTS } from "draft-core/live-sessions";

/**
 * Joins a topic and calls `onEvent` for each signal. Tells it `catch-up` each time the channel joins, and calls
 * `onConnected` when the channel joins or drops. Returns the leave function and a send function for the topic.
 */
export type SignalSource = (
  topic: string,
  onEvent: (event: string, payload?: unknown) => void,
  onConnected: (connected: boolean) => void,
) => { leave: () => void; send: (event: string, payload: unknown) => void };
export type SignalListener = (event: string, payload?: unknown) => void;

interface Held {
  leave: () => void;
  send: (event: string, payload: unknown) => void;
  listeners: Set<SignalListener>;
  connected: boolean;
}

/**
 * Owns the signal subscriptions of the main process. Several listeners of one topic share one channel.
 * The window gives the whole list of topics it wants each time that list changes; the manager joins
 * what is new and leaves what is gone, and drops the whole list when the window is replaced.
 */
export class RealtimeManager {
  private readonly held = new Map<string, Held>();
  private windowStops = new Map<string, () => void>();
  private reported: boolean | null = null;

  constructor(
    private readonly source: SignalSource,
    private readonly sendToWindow: (topic: string, event: string, payload?: unknown) => void,
    private readonly sendConnection: (connected: boolean) => void = () => {},
  ) {}

  watch(topic: string, listener: SignalListener): () => void {
    const existing = this.held.get(topic);
    let entry = existing;
    if (!entry) {
      const created: Held = { leave: () => {}, send: () => {}, listeners: new Set(), connected: false };
      this.held.set(topic, created);
      const channel = this.source(
        topic,
        (event, payload) => created.listeners.forEach((l) => l(event, payload)),
        (connected) => {
          created.connected = connected;
          this.reportConnection();
        },
      );
      created.leave = channel.leave;
      created.send = channel.send;
      entry = created;
      this.reportConnection();
    }
    entry.listeners.add(listener);
    if (existing?.connected) {
      queueMicrotask(() => {
        if (existing.listeners.has(listener)) listener(SIGNAL_EVENTS.catchUp);
      });
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || this.held.get(topic) !== entry) return;
      this.held.delete(topic);
      entry.leave();
      this.reportConnection();
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
      this.windowStops.set(topic, this.watch(topic, (event, payload) => this.sendToWindow(topic, event, payload)));
    }
    // A page that just loaded does not know the state, so it is told after every list.
    this.reportConnection(true);
  }

  send(topic: string, event: string, payload: unknown): void {
    this.held.get(topic)?.send(event, payload);
  }

  /** True when every joined topic is joined, and when there are none. */
  connected(): boolean {
    return [...this.held.values()].every((entry) => entry.connected);
  }

  private reportConnection(force = false): void {
    const now = this.connected();
    if (!force && now === this.reported) return;
    this.reported = now;
    this.sendConnection(now);
  }

  clearWindow(): void {
    this.setWindowTopics([]);
  }
}
