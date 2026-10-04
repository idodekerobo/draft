import { describe, expect, it } from "bun:test";
import { countRoutines, filterRoutines, formatAbsolute, previewNextRun } from "./format";
import type { Routine } from "./types";

function routine(overrides: Partial<Routine>): Routine {
  return {
    id: "r1",
    taskType: "synthesize_workspace",
    title: "Company context synthesis",
    routineDescription: "Uses new source material",
    scheduleDescription: "Daily at 09:00 (UTC)",
    preset: "daily",
    time: "09:00",
    weekday: null,
    timezone: "UTC",
    enabled: true,
    editable: "full",
    connectionLabel: null,
    needsReconnect: false,
    nextRunAt: null,
    lastCheckedAt: null,
    lastRun: null,
    updatedByName: null,
    ...overrides,
  };
}

const list = [
  routine({ id: "a" }),
  routine({ id: "b", title: "Slack import", connectionLabel: "Acme Slack", enabled: false }),
  routine({ id: "c", title: "Coding session summaries", routineDescription: "Summarizes sessions" }),
];

describe("filterRoutines / countRoutines", () => {
  it("counts the full list regardless of filter or search", () => {
    expect(countRoutines(list)).toEqual({ all: 3, active: 2, paused: 1 });
  });

  it("intersects the status filter with a trimmed case-insensitive search", () => {
    expect(filterRoutines(list, "paused", "  ACME ").map((r) => r.id)).toEqual(["b"]);
    expect(filterRoutines(list, "active", "acme")).toEqual([]);
    expect(filterRoutines(list, "all", "summarizes").map((r) => r.id)).toEqual(["c"]);
    expect(filterRoutines(list, "all", "").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("previewNextRun", () => {
  const now = new Date("2026-10-04T10:30:00.000Z");

  it("steps to the next top of the hour", () => {
    const next = previewNextRun({ preset: "hourly", time: "09:00", weekday: "mon", timezone: "UTC" }, now);
    expect(next.toISOString()).toBe("2026-10-04T11:00:00.000Z");
  });

  it("walks the Draft default slots in UTC", () => {
    const base = { preset: "draft_default", time: "09:00", weekday: "mon", timezone: "Asia/Tokyo" } as const;
    expect(previewNextRun(base, now).toISOString()).toBe("2026-10-04T11:00:00.000Z");
    expect(previewNextRun(base, new Date("2026-10-04T18:30:00.000Z")).toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(previewNextRun(base, new Date("2026-10-04T22:30:00.000Z")).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("respects the timezone and DST for daily runs", () => {
    const input = { preset: "daily", time: "09:00", weekday: "mon", timezone: "America/New_York" } as const;
    expect(previewNextRun(input, new Date("2026-01-15T00:00:00.000Z")).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(previewNextRun(input, new Date("2026-07-15T00:00:00.000Z")).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("skips weekends for weekdays and finds the chosen weekday for weekly", () => {
    const saturday = new Date("2026-10-03T12:00:00.000Z");
    const weekdays = { preset: "weekdays", time: "08:00", weekday: "mon", timezone: "UTC" } as const;
    expect(previewNextRun(weekdays, saturday).toISOString()).toBe("2026-10-05T08:00:00.000Z");
    const weekly = { preset: "weekly", time: "08:00", weekday: "fri", timezone: "UTC" } as const;
    expect(previewNextRun(weekly, saturday).toISOString()).toBe("2026-10-09T08:00:00.000Z");
  });
});

describe("formatAbsolute", () => {
  it("includes the timezone abbreviation", () => {
    expect(formatAbsolute("2026-10-04T14:00:00.000Z", "UTC")).toContain("UTC");
  });
});
