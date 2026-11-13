export const INPUT_FALLBACK_MS = 10_000;
export const INPUT_DISCONNECTED_MS = 2_000;
export const BUSY_REFETCH_MS = 2_000;

/**
 * Decides when a session host asks the server for pending inputs. A signal from the server asks at once. While the
 * last answer held inputs, it asks every BUSY_REFETCH_MS so deliveries and decisions are finished at the old pace.
 * Otherwise it asks only as a safety net, in case a signal was missed.
 */
export class InputWake {
  private wanted = true;
  private busy = false;
  private lastAsk = 0;

  constructor(
    private readonly fallbackMs = INPUT_FALLBACK_MS,
    private readonly now: () => number = Date.now,
    private readonly connected: () => boolean = () => true,
  ) {}

  /** The server says something changed, or the connection came back. */
  signal(): void {
    this.wanted = true;
  }

  due(): boolean {
    const interval = this.busy ? BUSY_REFETCH_MS : this.connected() ? this.fallbackMs : Math.min(this.fallbackMs, INPUT_DISCONNECTED_MS);
    return this.wanted || this.now() - this.lastAsk >= interval;
  }

  /** Call just before the request, so a signal that arrives during it is kept for the next pass. */
  asking(): void {
    this.wanted = false;
    this.lastAsk = this.now();
  }

  answered(count: number): void {
    this.busy = count > 0;
  }

  failed(): void {
    this.wanted = true;
  }
}
