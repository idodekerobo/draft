const MAX_KEYS = 1000;
let lastSeen = new Map<string, number>();

/** True at most once per window for a key, so repeated failures cannot flood the errors table. */
export function allowOncePer(key: string, windowMs: number, now: number = Date.now()): boolean {
  const previous = lastSeen.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;
  if (lastSeen.size >= MAX_KEYS) lastSeen = new Map();
  lastSeen.set(key, now);
  return true;
}

export function resetThrottleForTests(): void {
  lastSeen = new Map();
}
