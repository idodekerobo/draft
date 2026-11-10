export function runnerLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ source: "claude_runner", event, ...fields }));
}

// Failure reasons reach logs and the backend errors table, so strip anything
// that can carry a credential: the callback token, bearer values, signed URLs.
export function sanitizeReason(error: unknown, token = ""): string {
  let text = error instanceof Error ? error.message : String(error);
  if (token) text = text.split(token).join("[REDACTED]");
  text = text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1");
  return text.slice(0, 300);
}
