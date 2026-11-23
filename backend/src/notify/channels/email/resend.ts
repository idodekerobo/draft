/** The two Resend calls Draft makes: send one email, and read one email's latest event. */

const RESEND_API = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export type ResendEmail = { from: string; to: string[]; subject: string; text: string; html: string };

/** `statusCode` is null when no response came back. `resendName` is Resend's error name, such as `invalid_idempotent_request`. */
export class ResendError extends Error {
  constructor(
    public readonly statusCode: number | null,
    public readonly resendName: string | null,
  ) {
    super(`resend_failed: ${resendName ?? (statusCode === null ? "no_response" : `http_${statusCode}`)}`);
    this.name = "ResendError";
  }
}

export interface ResendDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function errorFrom(response: Response): Promise<ResendError> {
  const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
  return new ResendError(response.status, typeof body?.name === "string" ? body.name : null);
}

/** Network failures, timeouts, rate limits and 5xx are worth retrying. A 4xx means the request itself is wrong. */
const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Sends one email and returns Resend's id for it. The same `idempotencyKey` is sent on every attempt, so a retry after
 * a timeout reuses the provider request. Exhausted uncertain sends are not automatically retried later.
 */
export async function sendResendEmail(apiKey: string, email: ResendEmail, idempotencyKey: string, deps: ResendDeps = {}): Promise<{ id: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  let last: ResendError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(250 * 2 ** (attempt - 2));
    let response: Response;
    try {
      response = await fetchFn(`${RESEND_API}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(email),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      last = new ResendError(null, null);
      continue;
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id !== "string") throw new ResendError(response.status, "missing_id");
      return { id: body.id };
    }
    last = await errorFrom(response);
    if (!retryable(response.status)) throw last;
  }
  throw last ?? new ResendError(null, null);
}

/** Reads the latest event Resend has for one email. Needs a key that may read, not a send-only key. */
export async function getResendEmail(apiKey: string, emailId: string, deps: ResendDeps = {}): Promise<{ id: string; lastEvent: string | null }> {
  const fetchFn = deps.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${RESEND_API}/emails/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ResendError(null, null);
  }
  if (!response.ok) throw await errorFrom(response);
  const body = (await response.json().catch(() => null)) as { id?: unknown; last_event?: unknown } | null;
  if (typeof body?.id !== "string") throw new ResendError(response.status, "missing_id");
  return { id: body.id, lastEvent: typeof body.last_event === "string" ? body.last_event : null };
}
