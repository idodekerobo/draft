// Only ever redirect to a same-origin relative path. `next` arrives from a
// query string (attacker-controllable via a crafted link). Browsers treat "\"
// as "/" and strip tabs and newlines, so "/\evil.com" and "/\t/evil.com" both
// become "//evil.com". Reject backslashes and control characters outright.
export function safeNext(candidate: string | null | undefined, fallback = "/"): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  return candidate;
}
