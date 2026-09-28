// Only ever redirect to a same-origin relative path. `next` arrives from a
// query string (attacker-controllable via a crafted link), so an absolute or
// protocol-relative value ("https://evil.com", "//evil.com") must never be
// honored here — `new URL(candidate, anyBase)` returns `candidate` unchanged
// once it's already absolute, silently ignoring the intended origin.
export function safeNext(candidate: string | null | undefined, fallback = "/"): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  return candidate;
}
