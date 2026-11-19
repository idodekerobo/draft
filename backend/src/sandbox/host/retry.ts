import { HttpStatusError, TransportError } from "./cloud-services";

/** The wait before each retry at startup: five retries, so six tries in all. */
export const STARTUP_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface RetryOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (retry: number, error: unknown) => void;
}

/** A network failure or a 5xx can pass by the next try. A 4xx will not, so it is not retried. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  return error instanceof HttpStatusError && error.status >= 500;
}

/** Runs `attempt` again after each retryable failure, until it succeeds, fails for good, or the delays run out. */
export async function withStartupRetry<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delays ?? STARTUP_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryable(error) || retry >= delays.length) throw error;
      options.onRetry?.(retry + 1, error);
      await sleep(delays[retry]!);
    }
  }
}
