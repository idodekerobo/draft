export const WAKE_TICK_MS = 5_000;
export const WAKE_GAP_MS = 15_000;
const REVIVE_MIN_GAP_MS = 5_000;

export interface WakeDetectorOptions {
  onWake: () => void;
  now?: () => number;
  tickMs?: number;
  gapMs?: number;
}

/**
 * Electrobun has no sleep or wake event. Timers do not run while the computer sleeps, so a tick that comes
 * much later than it should means the computer slept. `nudge` is for other hints, such as the window
 * gaining focus. Both go through one throttle, so a burst of hints revives once.
 */
export function startWakeDetector(options: WakeDetectorOptions): { nudge: () => void; stop: () => void } {
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? WAKE_TICK_MS;
  const gapMs = options.gapMs ?? WAKE_GAP_MS;
  let lastTick = now();
  let lastRevive = Number.NEGATIVE_INFINITY;

  const revive = () => {
    const at = now();
    if (at - lastRevive < REVIVE_MIN_GAP_MS) return;
    lastRevive = at;
    try { options.onWake(); } catch (error) { console.error("[wake] revive failed", error); }
  };

  const timer = setInterval(() => {
    const at = now();
    const slept = at - lastTick > gapMs;
    lastTick = at;
    if (slept) revive();
  }, tickMs);

  return { nudge: revive, stop: () => clearInterval(timer) };
}
