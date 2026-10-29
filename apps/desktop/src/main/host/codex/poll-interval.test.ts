import { describe, expect, it } from "bun:test";
import { FAST_POLL_MS, IDLE_POLL_MS, codexPollMs } from "./poll-interval";

describe("codexPollMs", () => {
  const now = 1_000_000;

  it("is fast while a turn runs, however long ago anything else happened", () => {
    expect(codexPollMs({ busy: true, lastActivityAt: 0, now })).toBe(FAST_POLL_MS);
  });

  it("stays fast for 30 seconds after the last activity, then goes idle", () => {
    expect(codexPollMs({ busy: false, lastActivityAt: now - 29_000, now })).toBe(FAST_POLL_MS);
    expect(codexPollMs({ busy: false, lastActivityAt: now - 31_000, now })).toBe(IDLE_POLL_MS);
  });
});
