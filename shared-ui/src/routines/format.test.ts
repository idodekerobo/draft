import { describe, expect, it } from "bun:test";
import { countRoutines, filterRoutines, formatAbsolute, formatRelative, formatWhen, previewNextRun } from "./format";
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
    cron: null,
    intervalSeconds: null,
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

describe("time formatting", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");

  it("labels days and uses a 24-hour clock only for UTC", () => {
    expect(formatWhen("2026-10-04T09:02:00.000Z", "UTC", now)).toBe("Today, 09:02 UTC");
    expect(formatWhen("2026-10-03T18:45:00.000Z", "UTC", now)).toBe("Yesterday, 18:45 UTC");
    expect(formatWhen("2026-10-05T07:00:00.000Z", "America/New_York", now)).toBe("Tomorrow, 3:00 AM ET");
    expect(formatWhen("2026-10-07T01:00:00.000Z", "America/Los_Angeles", now)).toBe("Tuesday, 6:00 PM PT");
    expect(formatWhen("2026-09-25T20:00:00.000Z", "America/New_York", now)).toBe("Sep 25, 4:00 PM ET");
  });

  it("formats relative times", () => {
    expect(formatRelative("2026-10-04T12:42:00.000Z", now)).toBe("In 42 minutes");
    expect(formatRelative("2026-10-04T12:01:00.000Z", now)).toBe("In 1 minute");
    expect(formatRelative("2026-10-05T05:00:00.000Z", now)).toBe("In 17 hours");
    expect(formatRelative("2026-10-06T12:00:00.000Z", now)).toBe("In 2 days");
    expect(formatRelative("2026-10-04T11:00:00.000Z", now)).toBe("Due now");
  });

  it("formats the preview time with a zone label", () => {
    expect(formatAbsolute("2026-10-04T08:00:00.000Z", "UTC")).toBe("Oct 4, 8:00 AM UTC");
  });
});
