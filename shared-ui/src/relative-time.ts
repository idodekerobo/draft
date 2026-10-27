const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "5m ago", "2h ago", "3d ago", then a short date.
 * `compact` gives "now", "5m", "2h", "3d" and switches to a date after a week.
 */
export function relativeTime(iso: string, { now = Date.now(), compact = false }: { now?: number; compact?: boolean } = {}): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const label = (value: string) => (compact ? value : `${value} ago`);
  if (elapsed < MINUTE) return compact ? "now" : "just now";
  if (elapsed < HOUR) return label(`${Math.floor(elapsed / MINUTE)}m`);
  if (elapsed < DAY) return label(`${Math.floor(elapsed / HOUR)}h`);
  if (elapsed < (compact ? 7 : 30) * DAY) return label(`${Math.floor(elapsed / DAY)}d`);
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
