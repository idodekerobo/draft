import { describe, expect, it } from "bun:test";
import { SessionExpiredError, ServerError } from "draft-core/host/services";
import { HttpStatusError, TransportError } from "../../sandbox/host/cloud-services";
import { isRetryable, STARTUP_RETRY_DELAYS_MS, withStartupRetry } from "../../sandbox/host/retry";

/** Throws each error in turn, then returns "ok". Counts every call. */
function attempts(outcomes: Error[]) {
  let calls = 0;
  return {
    run: async (): Promise<string> => {
      const outcome = outcomes[calls];
      calls += 1;
      if (outcome) throw outcome;
      return "ok";
    },
    count: () => calls,
  };
}

function recordWaits() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("isRetryable", () => {
  it("retries a network failure and a 5xx", () => {
    expect(isRetryable(new TransportError(new TypeError("fetch failed")))).toBe(true);
    expect(isRetryable(new HttpStatusError("request_failed_500", 500))).toBe(true);
    expect(isRetryable(new HttpStatusError("request_failed_503", 503))).toBe(true);
  });

  it("does not retry a 4xx, a rejected login or an error it does not know", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(isRetryable(new HttpStatusError(`request_failed_${status}`, status))).toBe(false);
    }
    expect(isRetryable(new SessionExpiredError())).toBe(false);
    expect(isRetryable(new ServerError("session_ended"))).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});

describe("withStartupRetry", () => {
  it("waits one, two, four, eight and sixteen seconds between tries", () => {
    expect(STARTUP_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("returns the first success without waiting", async () => {
    const attempt = attempts([]);
    const waits = recordWaits();

    expect(await withStartupRetry(attempt.run, { sleep: waits.sleep })).toBe("ok");
    expect(attempt.count()).toBe(1);
    expect(waits.waits).toEqual([]);
  });

  it("retries a network failure until it succeeds, and reports each retry", async () => {
    const attempt = attempts([new TransportError(new TypeError("fetch failed")), new HttpStatusError("request_failed_503", 503)]);
    const waits = recordWaits();
    const retries: number[] = [];

    expect(await withStartupRetry(attempt.run, { sleep: waits.sleep, onRetry: (retry) => void retries.push(retry) })).toBe("ok");
    expect(attempt.count()).toBe(3);
    expect(waits.waits).toEqual([1_000, 2_000]);
    expect(retries).toEqual([1, 2]);
  });

  it("makes six tries in all, with five waits, before it gives up on a 5xx", async () => {
    const failure = new HttpStatusError("request_failed_503", 503);
    const attempt = attempts(Array.from({ length: 6 }, () => failure));
    const waits = recordWaits();

    await expect(withStartupRetry(attempt.run, { sleep: waits.sleep })).rejects.toBe(failure);
    expect(attempt.count()).toBe(6);
    expect(waits.waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("fails at once on a 4xx, with no wait", async () => {
    const failure = new HttpStatusError("not_found", 404);
    const attempt = attempts([failure]);
    const waits = recordWaits();

    await expect(withStartupRetry(attempt.run, { sleep: waits.sleep })).rejects.toBe(failure);
    expect(attempt.count()).toBe(1);
    expect(waits.waits).toEqual([]);
  });

  it("fails at once on a rejected login, which another try cannot fix", async () => {
    const failure = new SessionExpiredError();
    const attempt = attempts([failure]);

    await expect(withStartupRetry(attempt.run, { sleep: recordWaits().sleep })).rejects.toBe(failure);
    expect(attempt.count()).toBe(1);
  });

  it("stops after the configured delays run out", async () => {
    const failure = new TransportError(new TypeError("fetch failed"));
    const attempt = attempts([failure, failure, failure]);
    const waits = recordWaits();

    await expect(withStartupRetry(attempt.run, { delays: [5], sleep: waits.sleep })).rejects.toBe(failure);
    expect(attempt.count()).toBe(2);
    expect(waits.waits).toEqual([5]);
  });
});
