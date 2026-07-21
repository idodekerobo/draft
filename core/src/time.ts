// core/src/time.ts — shared "is this from today" logic.
//
// Used to cap backlog processing after the daemon has been off for a while:
// both the Codex session scanner and the pending-job drain need the same
// notion of "today" so a multi-day gap doesn't get synthesized all at once.

/** True if `a` and `b` fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

/** True if `iso` parses to a valid date that falls on the same local day as `now`. */
export function isToday(iso: string | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return isSameLocalDay(parsed, now);
}
