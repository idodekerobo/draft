import { describe, expect, it } from "bun:test";
import { startWakeDetector } from "./wake-detector";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("wake detector", () => {
  it("revives when a tick comes much later than expected", async () => {
    let clock = 0;
    let wakes = 0;
    const detector = startWakeDetector({ onWake: () => void wakes++, now: () => clock, tickMs: 10, gapMs: 1000 });
    await wait(25);
    expect(wakes).toBe(0);
    clock += 60_000;
    await wait(25);
    detector.stop();
    expect(wakes).toBe(1);
  });

  it("revives once for a burst of hints", () => {
    let clock = 100_000;
    let wakes = 0;
    const detector = startWakeDetector({ onWake: () => void wakes++, now: () => clock, tickMs: 60_000 });
    detector.nudge();
    detector.nudge();
    clock += 1_000;
    detector.nudge();
    expect(wakes).toBe(1);
    clock += 10_000;
    detector.nudge();
    detector.stop();
    expect(wakes).toBe(2);
  });
});
