import { describe, expect, it } from "bun:test";
import { relativeTime } from "./relative-time";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("words the age with 'ago' by default", () => {
    expect(relativeTime(ago(10_000), { now: NOW })).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), { now: NOW })).toBe("5m ago");
    expect(relativeTime(ago(2 * 3_600_000), { now: NOW })).toBe("2h ago");
    expect(relativeTime(ago(3 * 86_400_000), { now: NOW })).toBe("3d ago");
  });

  it("has a compact form that turns into a date after a week", () => {
    expect(relativeTime(ago(10_000), { now: NOW, compact: true })).toBe("now");
    expect(relativeTime(ago(5 * 60_000), { now: NOW, compact: true })).toBe("5m");
    expect(relativeTime(ago(3 * 86_400_000), { now: NOW, compact: true })).toBe("3d");
    expect(relativeTime(ago(8 * 86_400_000), { now: NOW, compact: true })).toMatch(/[A-Za-z]+ \d+/);
    expect(relativeTime(ago(8 * 86_400_000), { now: NOW })).toBe("8d ago");
  });

  it("treats a time in the future as now", () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), { now: NOW })).toBe("just now");
  });
});
