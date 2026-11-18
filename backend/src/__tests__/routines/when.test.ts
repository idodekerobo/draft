import { describe, expect, it } from "bun:test";
import { DRAFT_DEFAULT_CRON } from "../../scheduling/presets";
import { minCronGapSeconds, resolveWhen } from "../../routines/when";

const NOW = new Date("2026-11-16T12:00:00.000Z");

function resolved(when: Parameters<typeof resolveWhen>[0], timezone?: string) {
  const result = resolveWhen(when, NOW, timezone);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

describe("resolveWhen: once", () => {
  it.each([
    ["10m", "2026-11-16T12:10:00.000Z"],
    ["2h", "2026-11-16T14:00:00.000Z"],
    ["3d", "2026-11-19T12:00:00.000Z"],
  ])("resolves in: %s to %s", (duration, runAt) => {
    expect(resolved({ in: duration })).toEqual({ kind: "once", runAt: new Date(runAt), timezone: "UTC" });
  });

  it("reads an at with an offset as an instant", () => {
    expect(resolved({ at: "2026-11-20T10:00:00-05:00" })).toEqual({ kind: "once", runAt: new Date("2026-11-20T15:00:00.000Z"), timezone: "UTC" });
  });

  it("accepts exactly 365 days ahead and refuses one more", () => {
    const exactly = new Date(NOW.getTime() + 365 * 86_400_000).toISOString();
    expect(resolveWhen({ at: exactly }, NOW).ok).toBe(true);
    expect(resolveWhen({ in: "366d" }, NOW)).toEqual({
      ok: false,
      code: "too_far_ahead",
      field: "in",
      message: "A routine can be set at most 365 days ahead. You asked for 2027-11-17T12:00:00.000Z.",
    });
  });

  it("refuses a time that has passed", () => {
    expect(resolveWhen({ at: "2026-11-16T11:59:59.000Z" }, NOW)).toEqual({
      ok: false,
      code: "in_the_past",
      field: "at",
      message: "That time has already passed (2026-11-16T11:59:59.000Z). Use a future time.",
    });
  });

  it("refuses a time more than 365 days ahead", () => {
    const result = resolveWhen({ at: "2028-01-01T00:00:00.000Z" }, NOW);
    expect(result).toMatchObject({ ok: false, code: "too_far_ahead", field: "at" });
  });
});

describe("resolveWhen: rules", () => {
  it("builds a cron from a preset in UTC by default", () => {
    expect(resolved({ schedule: { preset: "daily", time: "09:00" } })).toEqual({
      kind: "rule",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      events: undefined,
    });
  });

  it("keeps the Draft default cron exactly, which fires hourly at its fastest", () => {
    expect(resolved({ schedule: { preset: "draft_default" } })).toMatchObject({ schedule: { cron: DRAFT_DEFAULT_CRON, timezone: "UTC" } });
  });

  it("accepts a custom cron in a valid timezone", () => {
    expect(resolved({ schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" } })).toMatchObject({
      schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
    });
  });

  it("names the field of a bad preset", () => {
    expect(resolveWhen({ schedule: { preset: "daily", time: "9am" } }, NOW)).toMatchObject({ ok: false, code: "invalid_schedule", field: "time" });
    expect(resolveWhen({ schedule: { preset: "weekly", time: "09:00" } }, NOW)).toMatchObject({ ok: false, code: "invalid_schedule", field: "weekday" });
    expect(resolveWhen({ schedule: { preset: "daily", time: "09:00", timezone: "Nope/Nope" } }, NOW)).toMatchObject({ ok: false, field: "timezone" });
  });

  it("refuses a custom cron that is not valid, or that never runs", () => {
    expect(resolveWhen({ schedule: { cron: "every day", timezone: "UTC" } }, NOW)).toMatchObject({ ok: false, code: "invalid_schedule", field: "cron" });
    expect(resolveWhen({ schedule: { cron: "0 0 30 2 *", timezone: "UTC" } }, NOW)).toMatchObject({ ok: false, code: "invalid_schedule", field: "cron" });
  });

  it("refuses a custom cron with an unknown timezone, and names the timezone", () => {
    expect(resolveWhen({ schedule: { cron: "0 9 * * *", timezone: "Nope/Nope" } }, NOW)).toMatchObject({ ok: false, field: "timezone" });
  });

  it("lets a person set a cron that fires more often than hourly", () => {
    expect(resolveWhen({ schedule: { cron: "* * * * *", timezone: "UTC" } }, NOW)).toMatchObject({ ok: true });
  });

  it("passes a null schedule through as off, and an omitted one as unchanged", () => {
    expect(resolved({ schedule: null, events: ["linear.issue_created"] })).toEqual({
      kind: "rule",
      schedule: null,
      events: ["linear.issue_created"],
    });
    expect(resolved({ events: [] })).toEqual({ kind: "rule", schedule: undefined, events: [] });
  });
});

describe("minCronGapSeconds", () => {
  it("is one hour for an hourly cron and one day for a daily one", () => {
    expect(minCronGapSeconds("0 * * * *", "UTC", NOW)).toBe(3600);
    expect(minCronGapSeconds("0 9 * * *", "UTC", NOW)).toBe(86400);
  });

  it("returns the shortest gap across the samples", () => {
    expect(minCronGapSeconds(DRAFT_DEFAULT_CRON, "UTC", NOW)).toBe(3600);
  });
});
