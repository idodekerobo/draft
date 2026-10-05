export type RoutinePreset = "draft_default" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type RoutineWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface RoutineLastRun {
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  completedAt: string | null;
}

/** One row from GET /workspaces/:id/schedules. */
export interface Routine {
  id: string;
  taskType: string;
  title: string;
  routineDescription: string;
  scheduleDescription: string;
  preset: RoutinePreset;
  time: string | null;
  weekday: RoutineWeekday | null;
  timezone: string;
  cron: string | null;
  intervalSeconds: number | null;
  enabled: boolean;
  editable: "full" | "toggle_only";
  connectionLabel: string | null;
  needsReconnect: boolean;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastRun: RoutineLastRun | null;
  updatedByName: string | null;
}

export interface RoutinesResponse {
  routines: Routine[];
  canEdit: boolean;
}

/** Body for PATCH /workspaces/:id/schedules/:taskId. */
export type RoutinePatch =
  | { enabled: boolean }
  | { preset: Exclude<RoutinePreset, "custom">; time?: string; weekday?: RoutineWeekday; timezone?: string };
