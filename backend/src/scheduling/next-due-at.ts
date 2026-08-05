import { CronExpressionParser } from "cron-parser";
import type { ScheduledTaskRow } from "../types/tables";

// Interval schedules compute from the previous next_due_at, clamped to
// `from`, to avoid a catch-up storm after downtime (fires once, not once
// per missed interval). Cron doesn't have this problem.
export function computeNextDueAt(task: ScheduledTaskRow, from: Date): Date {
  if (task.schedule_kind === "cron") {
    if (!task.cron_expression) {
      throw new Error(`Task ${task.id} is schedule_kind="cron" but has no cron_expression`);
    }
    const interval = CronExpressionParser.parse(task.cron_expression, {
      currentDate: from,
      tz: task.timezone,
    });
    return interval.next().toDate();
  }

  if (!task.interval_seconds) {
    throw new Error(`Task ${task.id} is schedule_kind="interval" but has no interval_seconds`);
  }
  const previousDueAt = task.next_due_at ? new Date(task.next_due_at) : from;
  const nextFromPrevious = new Date(previousDueAt.getTime() + task.interval_seconds * 1000);
  return nextFromPrevious.getTime() > from.getTime() ? nextFromPrevious : from;
}
