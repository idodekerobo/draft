import { serviceClient } from "../db/client";
import { loadDisplayNames } from "../routes/session-display-names";
import { computeNextDueAt } from "../scheduling/next-due-at";
import {
  buildSchedule,
  describeInterval,
  describeSchedule,
  parseSchedule,
  type ParsedPreset,
  type Weekday,
} from "../scheduling/presets";
import { ROUTINE_REGISTRY, ROUTINE_TASK_TYPES, type RoutineEditability } from "../scheduling/routine-registry";
import type { ScheduledTaskRow, SourceConnectionRow, SynthesisRunRow } from "../types/tables";
import type { SchedulePatch } from "./validate-patch";

const LIVE_CONNECTION_STATUSES = new Set(["active", "degraded"]);

export interface RoutineLastRun {
  status: SynthesisRunRow["status"];
  outcome: SynthesisRunRow["outcome"];
  completedAt: string | null;
}

export interface Routine {
  id: string;
  taskType: ScheduledTaskRow["task_type"];
  title: string;
  routineDescription: string;
  scheduleDescription: string;
  preset: ParsedPreset;
  time: string | null;
  weekday: Weekday | null;
  timezone: string;
  enabled: boolean;
  editable: RoutineEditability;
  connectionLabel: string | null;
  needsReconnect: boolean;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  // Synthesis only; other routines record checks, not runs.
  lastRun: RoutineLastRun | null;
  updatedByName: string | null;
}

type ConnectionInfo = Pick<SourceConnectionRow, "id" | "provider" | "status" | "display_name">;
type RunInfo = Pick<SynthesisRunRow, "status" | "outcome" | "completed_at">;

export class ScheduleServiceError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_schedule",
    readonly field?: string,
  ) {
    super(code);
  }
}

function parseOrCustom(task: ScheduledTaskRow) {
  if (task.schedule_kind === "cron" && task.cron_expression) {
    return parseSchedule(task.cron_expression, task.timezone);
  }
  return { preset: "custom" as const, time: null, weekday: null, timezone: task.timezone };
}

function toRoutine(
  task: ScheduledTaskRow,
  connection: ConnectionInfo | undefined,
  lastRun: RunInfo | null,
  updatedByName: string | null,
): Routine {
  const definition = ROUTINE_REGISTRY[task.task_type];
  if (!definition) throw new Error(`No routine definition for ${task.task_type}`);
  const parsed = parseOrCustom(task);
  const needsReconnect =
    task.source_connection_id !== null && !LIVE_CONNECTION_STATUSES.has(connection?.status ?? "");

  return {
    id: task.id,
    taskType: task.task_type,
    title: definition.title,
    routineDescription: definition.routineDescription,
    scheduleDescription:
      task.schedule_kind === "interval" && task.interval_seconds
        ? describeInterval(task.interval_seconds)
        : describeSchedule(parsed),
    preset: parsed.preset,
    time: parsed.time,
    weekday: parsed.weekday,
    timezone: task.timezone,
    enabled: task.enabled,
    editable: definition.editable,
    connectionLabel: connection ? (connection.display_name ?? connection.provider) : null,
    needsReconnect,
    nextRunAt: task.enabled ? task.next_due_at : null,
    lastCheckedAt: task.last_enqueued_at,
    lastRun: lastRun
      ? {
          status: lastRun.status,
          outcome: lastRun.outcome,
          completedAt: lastRun.completed_at,
        }
      : null,
    updatedByName,
  };
}

async function loadTasks(workspaceId: string): Promise<ScheduledTaskRow[]> {
  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("task_type", ROUTINE_TASK_TYPES)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTaskRow[];
}

async function loadConnections(workspaceId: string, ids: string[]): Promise<Map<string, ConnectionInfo>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await serviceClient
    .from("source_connections")
    .select("id, provider, status, display_name")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  if (error) throw error;
  return new Map(((data ?? []) as ConnectionInfo[]).map((row) => [row.id, row]));
}

// A failed lookup only hides the result; the rest of the list still loads.
async function loadLastSynthesisRun(workspaceId: string): Promise<RunInfo | null> {
  const { data, error } = await serviceClient
    .from("synthesis_runs")
    .select("status, outcome, completed_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["succeeded", "failed"])
    .order("completed_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("schedules: synthesis run lookup failed", error);
    return null;
  }
  return ((data ?? []) as RunInfo[])[0] ?? null;
}

async function loadUserNames(userIds: string[]): Promise<Map<string, string>> {
  const lookup = await loadDisplayNames(serviceClient, userIds, []);
  if (!lookup.ok) {
    console.error("schedules: user lookup failed", lookup.detail);
    return new Map();
  }
  return lookup.users;
}

async function buildRoutines(workspaceId: string, tasks: ScheduledTaskRow[]): Promise<Routine[]> {
  const connectionIds = tasks.flatMap((task) => (task.source_connection_id ? [task.source_connection_id] : []));
  const editorIds = [...new Set(tasks.flatMap((task) => (task.updated_by_user_id ? [task.updated_by_user_id] : [])))];
  const hasSynthesis = tasks.some((task) => task.task_type === "synthesize_workspace");

  const [connections, lastRun, names] = await Promise.all([
    loadConnections(workspaceId, connectionIds),
    hasSynthesis ? loadLastSynthesisRun(workspaceId) : Promise.resolve(null),
    loadUserNames(editorIds),
  ]);

  return tasks.map((task) =>
    toRoutine(
      task,
      task.source_connection_id ? connections.get(task.source_connection_id) : undefined,
      task.task_type === "synthesize_workspace" ? lastRun : null,
      task.updated_by_user_id ? (names.get(task.updated_by_user_id) ?? null) : null,
    ),
  );
}

export async function listRoutines(workspaceId: string): Promise<Routine[]> {
  return buildRoutines(workspaceId, await loadTasks(workspaceId));
}

export async function getRoutineTask(workspaceId: string, taskId: string): Promise<ScheduledTaskRow | null> {
  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("workspace_id", workspaceId)
    .in("task_type", ROUTINE_TASK_TYPES)
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledTaskRow | null) ?? null;
}

function safeNextDueAt(task: ScheduledTaskRow, now: Date): string {
  try {
    return computeNextDueAt(task, now).toISOString();
  } catch {
    throw new ScheduleServiceError("invalid_schedule");
  }
}

export async function updateRoutine(
  task: ScheduledTaskRow,
  patch: SchedulePatch,
  userId: string,
  now: Date = new Date(),
): Promise<Routine> {
  const changes: Partial<ScheduledTaskRow> = {};
  if (patch.enabled !== undefined) changes.enabled = patch.enabled;

  if (patch.schedule) {
    const built = buildSchedule(patch.schedule);
    if (!built.ok) throw new ScheduleServiceError("invalid_schedule", built.field);
    changes.schedule_kind = "cron";
    changes.cron_expression = built.cron;
    changes.interval_seconds = null;
    changes.timezone = built.timezone;
  }

  const next = { ...task, ...changes };
  const resumes = patch.enabled === true && !task.enabled;
  if (next.enabled && (patch.schedule || resumes)) {
    changes.next_due_at = safeNextDueAt(next, now);
  }

  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .update({ ...changes, updated_by_user_id: userId })
    .eq("id", task.id)
    .eq("workspace_id", task.workspace_id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ScheduleServiceError("not_found");

  console.log(
    JSON.stringify({
      event: "schedule_updated",
      workspaceId: task.workspace_id,
      taskId: task.id,
      userId,
      before: pickLogged(task),
      after: pickLogged(next),
    }),
  );

  const [routine] = await buildRoutines(task.workspace_id, [data as ScheduledTaskRow]);
  return routine!;
}

function pickLogged(task: ScheduledTaskRow) {
  return {
    enabled: task.enabled,
    cron: task.cron_expression,
    timezone: task.timezone,
  };
}
