import { describe, expect, it } from "bun:test";
import { InputWake } from "./input-wake";

function setup() {
  let time = 1_000_000;
  const wake = new InputWake(10_000, () => time);
  return { wake, advance: (ms: number) => void (time += ms) };
}

describe("InputWake", () => {
  it("asks on the first pass, then waits for a signal or the fallback", () => {
    const t = setup();
    expect(t.wake.due()).toBe(true);
    t.wake.asking();
    t.wake.answered(0);
    expect(t.wake.due()).toBe(false);
    t.advance(9_000);
    expect(t.wake.due()).toBe(false);
    t.advance(1_500);
    expect(t.wake.due()).toBe(true);
  });

  it("asks again after a signal", () => {
    const t = setup();
    t.wake.asking();
    t.wake.answered(0);
    t.wake.signal();
    expect(t.wake.due()).toBe(true);
  });

  it("asks every 2 s while the last answer held inputs, and stops when it is empty", () => {
    const t = setup();
    t.wake.asking();
    t.wake.answered(2);
    expect(t.wake.due()).toBe(false);
    t.advance(1_900);
    expect(t.wake.due()).toBe(false);
    t.advance(100);
    expect(t.wake.due()).toBe(true);
    t.wake.asking();
    t.wake.answered(0);
    expect(t.wake.due()).toBe(false);
  });

  it("keeps a signal that arrives during a request, and asks again after a failure", () => {
    const t = setup();
    t.wake.asking();
    t.wake.signal();
    t.wake.answered(0);
    expect(t.wake.due()).toBe(true);
    t.wake.asking();
    t.wake.answered(0);
    t.wake.asking();
    t.wake.failed();
    expect(t.wake.due()).toBe(true);
  });
});

describe("InputWake while the realtime connection is down", () => {
  function setupConnected() {
    let time = 1_000_000;
    let connected = true;
    const wake = new InputWake(10_000, () => time, () => connected);
    return {
      wake,
      advance: (ms: number) => void (time += ms),
      setConnected: (value: boolean) => void (connected = value),
    };
  }

  it("asks again after 2 s when the connection is down", () => {
    const t = setupConnected();
    t.setConnected(false);
    t.wake.asking();
    t.wake.answered(0);
    t.advance(1_900);
    expect(t.wake.due()).toBe(false);
    t.advance(200);
    expect(t.wake.due()).toBe(true);
  });

  it("waits the full 10 s when the connection is up", () => {
    const t = setupConnected();
    t.wake.asking();
    t.wake.answered(0);
    t.advance(9_900);
    expect(t.wake.due()).toBe(false);
    t.advance(200);
    expect(t.wake.due()).toBe(true);
  });

  it("goes back to 10 s when the connection returns", () => {
    const t = setupConnected();
    t.setConnected(false);
    t.wake.asking();
    t.wake.answered(0);
    t.setConnected(true);
    t.advance(2_500);
    expect(t.wake.due()).toBe(false);
    t.advance(7_500);
    expect(t.wake.due()).toBe(true);
  });
});
