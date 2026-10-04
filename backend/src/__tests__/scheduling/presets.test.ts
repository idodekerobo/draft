import { describe, expect, it } from "bun:test";
import { CronExpressionParser } from "cron-parser";
import {
  DRAFT_DEFAULT_CRON,
  buildSchedule,
  describeInterval,
  describeSchedule,
  parseSchedule,
  type ScheduleInput,
} from "../../scheduling/presets";

function roundTrip(input: ScheduleInput) {
  const built = buildSchedule(input);
  if (!built.ok) throw new Error(built.message);
  return { built, parsed: parseSchedule(built.cron, built.timezone) };
}

describe("buildSchedule / parseSchedule", () => {
  it("round-trips the Draft default exactly and fixes UTC", () => {
    const { built, parsed } = roundTrip({ preset: "draft_default", timezone: "America/New_York" });
    expect(built.cron).toBe(DRAFT_DEFAULT_CRON);
    expect(built.timezone).toBe("UTC");
    expect(parsed.preset).toBe("draft_default");
  });

  it("round-trips hourly, daily, weekdays and weekly", () => {
    expect(roundTrip({ preset: "hourly", timezone: "UTC" }).parsed.preset).toBe("hourly");
    expect(roundTrip({ preset: "daily", time: "09:05", timezone: "Europe/London" }).parsed).toMatchObject({
      preset: "daily",
      time: "09:05",
      timezone: "Europe/London",
    });
    expect(roundTrip({ preset: "weekdays", time: "18:00" }).parsed).toMatchObject({
      preset: "weekdays",
      time: "18:00",
    });
    expect(roundTrip({ preset: "weekly", time: "07:30", weekday: "fri" }).parsed).toMatchObject({
      preset: "weekly",
      time: "07:30",
      weekday: "fri",
    });
  });

  it("parses six-field cron with a fixed zero seconds field", () => {
    expect(parseSchedule("0 0 8 * * *", "UTC")).toMatchObject({ preset: "daily", time: "08:00" });
    expect(parseSchedule("0 0 0,4,8,9-18,22 * * *", "UTC").preset).toBe("draft_default");
    expect(parseSchedule("30 0 8 * * *", "UTC").preset).toBe("custom");
  });

  it("maps weekday 7 to Sunday", () => {
    expect(parseSchedule("0 8 * * 7", "UTC")).toMatchObject({ preset: "weekly", weekday: "sun" });
  });

  it("keeps unknown schedules as custom", () => {
    expect(parseSchedule("*/15 * * * *", "UTC").preset).toBe("custom");
    expect(parseSchedule("0 8 1 * *", "UTC").preset).toBe("custom");
    expect(parseSchedule("not a cron", "UTC").preset).toBe("custom");
  });

  it("treats the default cron in another timezone as custom", () => {
    expect(parseSchedule(DRAFT_DEFAULT_CRON, "America/New_York").preset).toBe("custom");
  });

  it("rejects invalid input with the offending field", () => {
    expect(buildSchedule({ preset: "daily", time: "25:00" })).toMatchObject({ ok: false, field: "time" });
    expect(buildSchedule({ preset: "daily" })).toMatchObject({ ok: false, field: "time" });
    expect(buildSchedule({ preset: "daily", time: "09:00", timezone: "Mars/Base" })).toMatchObject({
      ok: false,
      field: "timezone",
    });
    expect(buildSchedule({ preset: "weekly", time: "09:00" })).toMatchObject({ ok: false, field: "weekday" });
    expect(buildSchedule({ preset: "monthly" as never })).toMatchObject({ ok: false, field: "preset" });
  });

  it("builds a cron that fires at the local time across DST", () => {
    const built = buildSchedule({ preset: "daily", time: "09:00", timezone: "America/New_York" });
    if (!built.ok) throw new Error(built.message);
    const winter = CronExpressionParser.parse(built.cron, {
      currentDate: new Date("2026-01-15T00:00:00Z"),
      tz: built.timezone,
    }).next();
    const summer = CronExpressionParser.parse(built.cron, {
      currentDate: new Date("2026-07-15T00:00:00Z"),
      tz: built.timezone,
    }).next();
    expect(winter.toDate().toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(summer.toDate().toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });
});

describe("describeSchedule", () => {
  it("describes the cadence without the timezone", () => {
    expect(describeSchedule(parseSchedule("0 15 * * 1", "UTC"))).toBe("Mondays at 3:00 PM");
    expect(describeSchedule(parseSchedule("0 3 * * *", "America/New_York"))).toBe("Daily at 3:00 AM");
    expect(describeSchedule(parseSchedule("0 0 * * 1-5", "UTC"))).toBe("Weekdays at 12:00 AM");
    expect(describeSchedule(parseSchedule("*/5 * * * *", "UTC"))).toBe("Custom schedule");
    expect(describeSchedule(parseSchedule(DRAFT_DEFAULT_CRON, "UTC"))).toBe("Hourly, 9 AM–6 PM; every ~4h overnight");
  });

  it("describes intervals", () => {
    expect(describeInterval(300)).toBe("Every 5 minutes");
    expect(describeInterval(3600)).toBe("Every hour");
    expect(describeInterval(7200)).toBe("Every 2 hours");
  });
});
