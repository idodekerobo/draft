import type { ScheduledTaskRow } from "../types/tables";

export type RoutineKind = "once" | "recurring" | "event";

/** An agent routine whose schedule is off has no next run; only its triggers and Run now start it. */
export function runsOnSchedule(task: Pick<ScheduledTaskRow, "task_type" | "config_json">): boolean {
  return task.task_type !== "agent_routine" || (task.config_json as { onSchedule?: unknown } | null)?.onSchedule !== false;
}

/** One rule for every list, so the Routines tab and Activity never disagree. A routine with its schedule off is an event routine. */
export function routineKind(task: Pick<ScheduledTaskRow, "schedule_kind" | "task_type" | "config_json">): RoutineKind {
  if (task.schedule_kind === "once") return "once";
  return runsOnSchedule(task) ? "recurring" : "event";
}
