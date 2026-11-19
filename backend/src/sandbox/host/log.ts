type LogValue = string | number | boolean | null;

const secrets: string[] = [];

/** Values that must never reach the log. The host sets them once it has read its environment. */
export function setRedactions(values: string[]): void {
  secrets.splice(0, secrets.length, ...values.filter((value) => value.length > 0));
}

/** Removes secrets, bearer tokens, URL credentials and signed URL queries. */
export function redact(text: string, values: readonly string[] = secrets): string {
  let clean = text;
  for (const value of values) clean = clean.split(value).join("[REDACTED]");
  return clean
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\/\/[^/\s@]+@/g, "//[REDACTED]@")
    .replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?[REDACTED]");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One JSON line on stderr. Every string field is redacted. */
export function hostLog(level: "info" | "error", event: string, fields: Record<string, LogValue> = {}): void {
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? redact(value).slice(0, 400) : value]));
  process.stderr.write(`${JSON.stringify({ source: "sandbox_host", level, event, ...safe })}\n`);
}
