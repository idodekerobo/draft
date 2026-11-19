/** How long a session stays awake after its last input, when no turn runs and no approval waits. */
export const IDLE_SLEEP_MS = 10 * 60_000;
/** A permission request keeps the session awake only this long. After that it counts as no longer waiting. */
export const APPROVAL_WAIT_MS = 30 * 60_000;
/** The sleep decision needs an input check this recent. A pass runs every few seconds, so an older check means a stalled pass. */
export const INPUT_CHECK_MAX_AGE_MS = 30_000;

export interface IdleSnapshot {
  now: number;
  turnRunning: boolean;
  lastInputAt: number;
  openApprovalsSince: number[];
  pendingInputs: number;
  inputsCheckedAt: number;
}

/**
 * True when the session may sleep: no turn runs, no input waits in the queue, no recent approval waits, the input
 * check is fresh, and no input came for IDLE_SLEEP_MS. A queued input keeps the host up until the pane takes it.
 */
export function canSleep(snapshot: IdleSnapshot): boolean {
  if (snapshot.turnRunning) return false;
  if (snapshot.pendingInputs > 0) return false;
  if (snapshot.now - snapshot.inputsCheckedAt > INPUT_CHECK_MAX_AGE_MS) return false;
  if (snapshot.openApprovalsSince.some((asked) => snapshot.now - asked < APPROVAL_WAIT_MS)) return false;
  return snapshot.now - snapshot.lastInputAt >= IDLE_SLEEP_MS;
}
