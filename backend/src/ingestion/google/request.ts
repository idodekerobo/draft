export interface GoogleErrorInfo {
  status: number;
  // Google's machine-readable reason, such as rateLimitExceeded or insufficientPermissions.
  reason: string | null;
  message: string | null;
  retryAfterMs: number | null;
}

export type GoogleRequestResult = { ok: true; response: Response } | { ok: false; info: GoogleErrorInfo; attempts: number };

export interface GoogleRequestOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "backendError"]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

export async function readGoogleError(response: Response): Promise<GoogleErrorInfo> {
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> };
    error_description?: string;
  } | null;
  const error = body?.error;
  const detail = typeof error === "object" && error !== null ? error : null;
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: response.status,
    reason: detail?.errors?.[0]?.reason ?? detail?.status ?? (typeof error === "string" ? error : null),
    message: detail?.message ?? body?.error_description ?? null,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : null,
  };
}

export function isGoogleRateLimit(info: GoogleErrorInfo): boolean {
  return info.status === 429 || (info.status === 403 && info.reason !== null && /ratelimit|quota|limitexceeded/i.test(info.reason));
}

function isRetryable(info: GoogleErrorInfo): boolean {
  if (RETRYABLE_STATUSES.has(info.status)) return true;
  return info.status === 403 && info.reason !== null && RETRYABLE_REASONS.has(info.reason);
}

// Keeps Google's reason in the message, because only the message reaches the errors table.
export function describeGoogleError(label: string, info: GoogleErrorInfo, attempts = 1): string {
  const reason = info.reason ? ` (${info.reason})` : "";
  const detail = info.message ? `: ${info.message}` : "";
  const retries = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `${label} request failed with status ${info.status}${reason}${detail}${retries}`;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Retries rate limits and transient server errors with backoff. Any other
// failure comes back at once so the caller can map it.
export async function googleRequest(
  send: () => Promise<Response>,
  options: GoogleRequestOptions = {},
): Promise<GoogleRequestResult> {
  const maxRetries = options.maxRetries ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    const response = await send();
    if (response.ok) return { ok: true, response };
    const info = await readGoogleError(response);
    if (attempt > maxRetries || !isRetryable(info)) return { ok: false, info, attempts: attempt };
    const backoff = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    await sleep(info.retryAfterMs ?? backoff + Math.floor(random() * 250));
  }
}
