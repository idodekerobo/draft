/** How long a session stays awake after its last input, when no turn runs and no approval waits. */
export const IDLE_SLEEP_MS = 10 * 60_000;
/** A permission request keeps the session awake only this long. After that it counts as no longer waiting. */
export const APPROVAL_WAIT_MS = 30 * 60_000;

export interface IdleSnapshot {
  now: number;
  turnRunning: boolean;
  lastInputAt: number;
  openApprovalsSince: number[];
}

/** True when the session may sleep: no turn runs, no recent approval waits, and no input came for IDLE_SLEEP_MS. */
export function canSleep(snapshot: IdleSnapshot): boolean {
  if (snapshot.turnRunning) return false;
  if (snapshot.openApprovalsSince.some((asked) => snapshot.now - asked < APPROVAL_WAIT_MS)) return false;
  return snapshot.now - snapshot.lastInputAt >= IDLE_SLEEP_MS;
}
