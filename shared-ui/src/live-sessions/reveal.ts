export const CATCH_UP_MS = 300;
export const MIN_CHARS_PER_SECOND = 40;
export const MAX_FRAME_MS = 100;

/** How many characters to show after `dtMs` more milliseconds. The pace rises with the backlog, so the shown text is never far behind. */
export function nextShown(shown: number, target: number, dtMs: number): number {
  if (shown >= target) return target;
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  const backlog = target - shown;
  const charsPerMs = Math.max(MIN_CHARS_PER_SECOND / 1000, backlog / CATCH_UP_MS);
  const step = Math.max(1, Math.round(charsPerMs * dt));
  return Math.min(target, shown + step);
}

/** A cut position that does not split a surrogate pair. */
export function safeCut(text: string, length: number): number {
  const cut = Math.min(Math.max(length, 0), text.length);
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut < text.length) return cut + 1;
  return cut;
}
