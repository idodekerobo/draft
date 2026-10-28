import { beforeEach, describe, expect, it } from "bun:test";
import { allowOncePer, resetThrottleForTests } from "../../errors/throttle";

describe("allowOncePer", () => {
  beforeEach(() => resetThrottleForTests());
  it("allows the first call and blocks repeats inside the window", () => {
    expect(allowOncePer("k", 1000, 0)).toBe(true);
    expect(allowOncePer("k", 1000, 999)).toBe(false);
  });
  it("allows again once the window has passed", () => {
    allowOncePer("k", 1000, 0);
    expect(allowOncePer("k", 1000, 1000)).toBe(true);
  });
  it("tracks keys separately", () => {
    allowOncePer("a", 1000, 0);
    expect(allowOncePer("b", 1000, 1)).toBe(true);
  });
});
