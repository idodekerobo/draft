import { describe, expect, it } from "bun:test";
import { startHeartbeat } from "./heartbeat";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("heartbeat", () => {
  it("sends at once, then every interval, until stopped", async () => {
    let calls = 0;
    const stop = startHeartbeat(async () => void calls++, 20);
    await wait(70);
    stop();
    const seen = calls;
    expect(seen).toBeGreaterThanOrEqual(3);
    await wait(50);
    expect(calls).toBe(seen);
  });

  it("does not start a beat while the last one is still running", async () => {
    let running = 0;
    let overlap = false;
    const stop = startHeartbeat(async () => {
      if (++running > 1) overlap = true;
      await wait(60);
      running--;
    }, 10);
    await wait(150);
    stop();
    expect(overlap).toBe(false);
  });
});
