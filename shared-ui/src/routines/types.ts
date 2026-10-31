import type { HarnessId } from "draft-core/harnesses";

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
  harness: HarnessId;
  /** Alias the harness CLI takes as its model; null for the harness default. */
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

/** Whether the workspace's routines can run on an agent. A login that stopped working needs a new sign-in. */
export type RoutineAgentStatus = "connected" | "not_connected" | "needs_reconnect";

export interface RoutinesResponse {
  routines: Routine[];
  canEdit: boolean;
  /** By harness id. An agent with no entry is treated as ready. */
  agents?: Partial<Record<string, RoutineAgentStatus>>;
}

/** What a person can change on an agent routine. Send only the fields that changed. */
export interface AgentRoutineEdit {
  title?: string;
  prompt?: string;
  harness?: HarnessId;
  model?: string | null;
}

/** Body for PATCH /workspaces/:id/schedules/:taskId. */
export type RoutinePatch =
  | { enabled: boolean }
  | (AgentRoutineEdit & { preset?: Exclude<RoutinePreset, "custom">; time?: string; weekday?: RoutineWeekday; timezone?: string });

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export interface CreateRoutineInput {
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string | null;
  preset: Exclude<RoutinePreset, "custom" | "draft_default">;
  time?: string;
  weekday?: RoutineWeekday;
  timezone?: string;
}
