export const FAST_POLL_MS = 500;
export const IDLE_POLL_MS = 2_000;
const ACTIVE_WINDOW_MS = 30_000;

/** Waits briefly while a turn runs and just after anything happened, so a message is picked up quickly. */
export function codexPollMs(state: { busy: boolean; lastActivityAt: number; now: number }): number {
  return state.busy || state.now - state.lastActivityAt < ACTIVE_WINDOW_MS ? FAST_POLL_MS : IDLE_POLL_MS;
}
