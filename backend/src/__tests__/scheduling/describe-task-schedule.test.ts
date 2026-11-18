import { describe, expect, it } from "bun:test";
import { describeTaskSchedule } from "../../scheduling/describe-task-schedule";
import { describeRoutineSetup } from "../../routines/dispatch-routine";
import type { ScheduledTaskRow } from "../../types/tables";

const once = (timezone: string) =>
  ({ schedule_kind: "once", cron_expression: null, interval_seconds: null, run_at: "2026-11-16T14:00:00.000Z", timezone }) as unknown as ScheduledTaskRow;

describe("describeTaskSchedule", () => {
  it("names the time of a once in its timezone", () => {
    expect(describeTaskSchedule(once("UTC"))).toBe("Once at Nov 16, 2026 at 2:00 PM UTC");
    expect(describeTaskSchedule(once("America/New_York"))).toBe("Once at Nov 16, 2026 at 9:00 AM EST");
  });
});

describe("describeRoutineSetup", () => {
  it("says when a once runs, with no repeat or triggers after it", () => {
    expect(describeRoutineSetup(once("UTC"), { onSchedule: undefined, events: undefined })).toBe("Once at Nov 16, 2026 at 2:00 PM UTC");
  });

  it("keeps the cadence and timezone for a repeating routine", () => {
    const daily = { schedule_kind: "cron", cron_expression: "0 9 * * *", interval_seconds: null, timezone: "UTC" } as unknown as ScheduledTaskRow;
    expect(describeRoutineSetup(daily, { onSchedule: undefined, events: ["linear.issue_created"] })).toBe("Daily at 9:00 AM (UTC), and when a Linear issue is created");
  });
});
