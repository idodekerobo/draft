import type { ScheduledTaskRow } from "../types/tables";
import { describeInterval, describeSchedule, parseSchedule } from "./presets";

/** The cadence in words, for example "Daily at 9:00 AM". A once names its time and timezone. Otherwise the timezone is not part of it. */
export function describeTaskSchedule(
  task: Pick<ScheduledTaskRow, "schedule_kind" | "cron_expression" | "interval_seconds" | "timezone" | "run_at">,
): string {
  if (task.schedule_kind === "once" && task.run_at) return describeOnce(task.run_at, task.timezone);
  if (task.schedule_kind === "interval" && task.interval_seconds) return describeInterval(task.interval_seconds);
  if (task.schedule_kind === "cron" && task.cron_expression) return describeSchedule(parseSchedule(task.cron_expression, task.timezone));
  return "Custom schedule";
}

function describeOnce(runAt: string, timezone: string): string {
  const when = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timezone,
  }).format(new Date(runAt));
  return `Once at ${when}`;
}
