import { describe, expect, it } from "bun:test";
import { nextShown, safeCut } from "./reveal";

describe("nextShown", () => {
  it("advances a small backlog at the minimum pace", () => {
    expect(nextShown(0, 5, 16)).toBe(2);
    expect(nextShown(0, 5, 4)).toBe(1);
  });

  it("drains a long backlog toward the target over 16 ms frames", () => {
    let shown = 0;
    let time = 0;
    while (shown < 1000 && time < 400) {
      shown = nextShown(shown, 1000, 16);
      time += 16;
    }
    expect(shown).toBeGreaterThanOrEqual(600);
  });

  it("never passes the target", () => {
    expect(nextShown(4, 5, 100_000)).toBe(5);
    expect(nextShown(9, 5, 16)).toBe(5);
  });

  it("caps a long frame gap at the maximum frame time", () => {
    expect(nextShown(0, 1000, 5000)).toBe(nextShown(0, 1000, 100));
  });

  it("advances by one character when no time has passed", () => {
    expect(nextShown(0, 5, 0)).toBe(1);
  });
});

describe("safeCut", () => {
  it("does not split an emoji", () => {
    const text = "a😀b";
    expect(safeCut(text, 2)).toBe(3);
    expect(safeCut(text, 3)).toBe(3);
  });

  it("clamps the length", () => {
    expect(safeCut("abc", -4)).toBe(0);
    expect(safeCut("abc", 99)).toBe(3);
  });
});
