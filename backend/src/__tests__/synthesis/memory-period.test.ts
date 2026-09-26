import { describe, expect, it } from "bun:test";
import { resolveMemoryPeriod } from "../../synthesis/memory-period";

// 2026-09-25 is a Thursday (in UTC and in America/Los_Angeles at this hour).
const THURSDAY = new Date("2026-09-25T18:00:00.000Z");

describe("resolveMemoryPeriod", () => {
  it("resolves today/yesterday to day paths", () => {
    expect(resolveMemoryPeriod("today", "UTC", THURSDAY)).toEqual({
      kind: "day",
      id: "2026-09-25",
      path: "memory/days/2026-09-25.md",
      start: "2026-09-25",
      end: "2026-09-25",
    });
    expect(resolveMemoryPeriod("yesterday", "UTC", THURSDAY)).toMatchObject({
      kind: "day",
      id: "2026-09-24",
    });
  });

  it("resolves this-week/last-week to the containing Monday", () => {
    expect(resolveMemoryPeriod("this-week", "UTC", THURSDAY)).toEqual({
      kind: "week",
      id: "2026-09-21",
      path: "memory/weeks/2026-09-21.md",
      start: "2026-09-21",
      end: "2026-09-27",
    });
    expect(resolveMemoryPeriod("last-week", "UTC", THURSDAY)).toMatchObject({
      kind: "week",
      id: "2026-09-14",
    });
  });

  it("resolves this-month/last-month, including year rollover", () => {
    expect(resolveMemoryPeriod("this-month", "UTC", THURSDAY)).toEqual({
      kind: "month",
      id: "2026-09",
      path: "memory/months/2026-09.md",
      start: "2026-09-01",
      end: "2026-09-30",
    });
    const january = new Date("2026-01-15T12:00:00.000Z");
    expect(resolveMemoryPeriod("last-month", "UTC", january)).toEqual({
      kind: "month",
      id: "2025-12",
      path: "memory/months/2025-12.md",
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("accepts an explicit day id", () => {
    expect(resolveMemoryPeriod("2026-09-16", "UTC", THURSDAY)).toEqual({
      kind: "day",
      id: "2026-09-16",
      path: "memory/days/2026-09-16.md",
      start: "2026-09-16",
      end: "2026-09-16",
    });
  });

  it("accepts an explicit week id (week-<monday>) and rejects a non-Monday", () => {
    expect(resolveMemoryPeriod("week-2026-09-21", "UTC", THURSDAY)).toMatchObject({
      kind: "week",
      id: "2026-09-21",
    });
    expect(() => resolveMemoryPeriod("week-2026-09-22", "UTC", THURSDAY)).toThrow(/must be a Monday/);
  });

  it("accepts an explicit month id", () => {
    expect(resolveMemoryPeriod("2026-02", "UTC", THURSDAY)).toEqual({
      kind: "month",
      id: "2026-02",
      path: "memory/months/2026-02.md",
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("resolves timezone-sensitive aliases using the given IANA timezone, not UTC", () => {
    // 2026-09-25T18:00:00Z is 2026-09-26 03:00 in Tokyo -- "today" should
    // follow the workspace's timezone, not the host's.
    expect(resolveMemoryPeriod("today", "Asia/Tokyo", THURSDAY)).toMatchObject({
      id: "2026-09-26",
    });
  });

  it("rejects unrecognized input", () => {
    expect(() => resolveMemoryPeriod("next-week", "UTC", THURSDAY)).toThrow(/unrecognized period/);
    expect(() => resolveMemoryPeriod("2026-13", "UTC", THURSDAY)).toThrow(/invalid month id/);
  });
});
