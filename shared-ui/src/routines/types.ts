export type RoutinePreset = "draft_default" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type RoutineWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface RoutineLastRun {
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  completedAt: string | null;
}

export type RoutineRunStatus = "running" | "completed" | "failed";

/** One run of an agent routine. The id opens the run in the session view. */
export interface RoutineRun {
  id: string;
  status: RoutineRunStatus;
  startedAt: string;
  endedAt: string | null;
}

/** Set only on agent routines. */
export interface AgentRoutine {
  prompt: string;
  harness: "claude";
  /** Alias for `claude --model`; null for the harness default. */
  model: string | null;
  createdByName: string | null;
  lastRun: RoutineRun | null;
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
  agent: AgentRoutine | null;
}

export interface RoutinesResponse {
  routines: Routine[];
  canEdit: boolean;
}

/** Body for PATCH /workspaces/:id/schedules/:taskId. */
export type RoutinePatch =
  | { enabled: boolean }
  | { preset: Exclude<RoutinePreset, "custom">; time?: string; weekday?: RoutineWeekday; timezone?: string };

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export interface CreateRoutineInput {
  title: string;
  prompt: string;
  harness: "claude";
  model: string | null;
  preset: Exclude<RoutinePreset, "custom" | "draft_default">;
  time?: string;
  weekday?: RoutineWeekday;
  timezone?: string;
}
