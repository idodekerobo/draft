import type { ScheduledTaskRow } from "../types/tables";
import { describeInterval, describeSchedule, parseSchedule } from "./presets";

/** The cadence in words, for example "Daily at 9:00 AM". The timezone is not part of it. */
export function describeTaskSchedule(
  task: Pick<ScheduledTaskRow, "schedule_kind" | "cron_expression" | "interval_seconds" | "timezone">,
): string {
  if (task.schedule_kind === "interval" && task.interval_seconds) return describeInterval(task.interval_seconds);
  if (task.schedule_kind === "cron" && task.cron_expression) return describeSchedule(parseSchedule(task.cron_expression, task.timezone));
  return "Custom schedule";
}
