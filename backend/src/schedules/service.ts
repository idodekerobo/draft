import { randomUUID } from "node:crypto";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { loadDisplayNames } from "../routes/session-display-names";
import { computeNextDueAt } from "../scheduling/next-due-at";
import {
  buildSchedule,
  type ScheduleInput,
  describeInterval,
  describeSchedule,
  parseSchedule,
  type ParsedPreset,
  type Weekday,
} from "../scheduling/presets";
import { parseAgentRoutineConfig, type AgentRoutineConfig } from "../routines/config";
import {
  ROUTINE_TASK_TYPES,
  agentRoutineDefinition,
  providerName,
  resolveRoutine,
  type RoutineDefinition,
  type RoutineEditability,
} from "../scheduling/routine-registry";
import type { ScheduledTaskRow, SessionRow, SourceConnectionRow, SynthesisRunRow } from "../types/tables";
import type { SchedulePatch } from "./validate-patch";

const LIVE_CONNECTION_STATUSES = new Set(["active", "degraded"]);

export interface RoutineLastRun {
  status: SynthesisRunRow["status"];
  outcome: SynthesisRunRow["outcome"];
  completedAt: string | null;
}

export type RoutineRunStatus = "running" | "completed" | "failed";

export interface RoutineRun {
  id: string;
  status: RoutineRunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentRoutineInfo {
  prompt: string;
  harness: AgentRoutineConfig["harness"];
  model: string | null;
  createdByName: string | null;
  lastRun: RoutineRun | null;
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
  cron: string | null;
  intervalSeconds: number | null;
  enabled: boolean;
  editable: RoutineEditability;
  connectionLabel: string | null;
  needsReconnect: boolean;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  // Synthesis only; other routines record checks, not runs.
  lastRun: RoutineLastRun | null;
  updatedByName: string | null;
  // Agent routines only.
  agent: AgentRoutineInfo | null;
}

type ConnectionInfo = Pick<SourceConnectionRow, "id" | "provider" | "status">;
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
  definition: RoutineDefinition,
  connection: ConnectionInfo | undefined,
  lastRun: RunInfo | null,
  updatedByName: string | null,
  agent: AgentRoutineInfo | null = null,
): Routine {
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
    cron: task.schedule_kind === "cron" ? task.cron_expression : null,
    intervalSeconds: task.schedule_kind === "interval" ? task.interval_seconds : null,
    enabled: task.enabled,
    editable: definition.editable,
    connectionLabel: connection ? providerName(connection.provider) : null,
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
    agent,
  };
}

type RunRow = Pick<SessionRow, "id" | "status" | "end_reason" | "started_at" | "ended_at"> & { scheduled_task_id: string };

function toRoutineRun(row: RunRow): RoutineRun {
  const status: RoutineRunStatus =
    row.status !== "ended" ? "running" : row.end_reason === "completed" ? "completed" : "failed";
  return { id: row.id, status, startedAt: row.started_at, endedAt: row.ended_at };
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
    .select("id, provider, status")
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
    recordRouteError({ workspaceId, errorCode: "schedules_last_run_failed", error });
    return null;
  }
  return ((data ?? []) as RunInfo[])[0] ?? null;
}

async function loadUserNames(workspaceId: string, userIds: string[]): Promise<Map<string, string>> {
  const lookup = await loadDisplayNames(serviceClient, userIds, []);
  if (!lookup.ok) {
    recordRouteError({ workspaceId, errorCode: "schedules_editor_names_failed", error: lookup.detail });
    return new Map();
  }
  return lookup.users;
}

// A failed lookup only hides the last run; the rest of the list still loads.
async function loadLastAgentRuns(workspaceId: string, taskIds: string[]): Promise<Map<string, RoutineRun>> {
  if (taskIds.length === 0) return new Map();
  const { data, error } = await serviceClient
    .from("sessions")
    .select("id, status, end_reason, started_at, ended_at, scheduled_task_id")
    .eq("workspace_id", workspaceId)
    .in("scheduled_task_id", taskIds)
    .order("started_at", { ascending: false })
    .limit(taskIds.length * 5);
  if (error) {
    recordRouteError({ workspaceId, errorCode: "schedules_last_agent_run_failed", error });
    return new Map();
  }
  const latest = new Map<string, RoutineRun>();
  for (const row of (data ?? []) as RunRow[]) {
    if (!latest.has(row.scheduled_task_id)) latest.set(row.scheduled_task_id, toRoutineRun(row));
  }
  return latest;
}

async function buildRoutines(
  workspaceId: string,
  tasks: ScheduledTaskRow[],
  knownConnections?: Map<string, ConnectionInfo>,
): Promise<Routine[]> {
  const connectionIds = tasks.flatMap((task) => (task.source_connection_id ? [task.source_connection_id] : []));
  const editorIds = [
    ...new Set(tasks.flatMap((task) => [task.updated_by_user_id, task.created_by_user_id].filter((id): id is string => id !== null))),
  ];
  const agentTaskIds = tasks.filter((task) => task.task_type === "agent_routine").map((task) => task.id);
  const hasSynthesis = tasks.some((task) => task.task_type === "synthesize_workspace");

  const [connections, lastRun, names, lastAgentRuns] = await Promise.all([
    knownConnections ?? loadConnections(workspaceId, connectionIds),
    hasSynthesis ? loadLastSynthesisRun(workspaceId) : Promise.resolve(null),
    loadUserNames(workspaceId, editorIds),
    loadLastAgentRuns(workspaceId, agentTaskIds),
  ]);

  return tasks.flatMap((task) => {
    if (task.task_type === "agent_routine") {
      const config = parseAgentRoutineConfig(task.config_json);
      if (!config) {
        console.warn(`Skipping scheduled task ${task.id}: invalid agent routine config`);
        return [];
      }
      const agent: AgentRoutineInfo = {
        prompt: config.prompt,
        harness: config.harness,
        model: config.model,
        createdByName: task.created_by_user_id ? (names.get(task.created_by_user_id) ?? null) : null,
        lastRun: lastAgentRuns.get(task.id) ?? null,
      };
      return [
        toRoutine(
          task,
          agentRoutineDefinition(config.title),
          undefined,
          null,
          task.updated_by_user_id ? (names.get(task.updated_by_user_id) ?? null) : null,
          agent,
        ),
      ];
    }
    const connection = task.source_connection_id ? connections.get(task.source_connection_id) : undefined;
    const definition = resolveRoutine(task.task_type, connection?.provider ?? null);
    if (!definition) {
      console.warn(
        `Skipping scheduled task ${task.id}: no routine for ${task.task_type} with provider ${connection?.provider ?? "none"}`,
      );
      return [];
    }
    return [
      toRoutine(
        task,
        definition,
        connection,
        task.task_type === "synthesize_workspace" ? lastRun : null,
        task.updated_by_user_id ? (names.get(task.updated_by_user_id) ?? null) : null,
      ),
    ];
  });
}

export async function listRoutines(workspaceId: string): Promise<Routine[]> {
  return buildRoutines(workspaceId, await loadTasks(workspaceId));
}

export interface RoutineTask {
  task: ScheduledTaskRow;
  definition: RoutineDefinition;
  connection: ConnectionInfo | undefined;
}

export async function getRoutineTask(workspaceId: string, taskId: string): Promise<RoutineTask | null> {
  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("workspace_id", workspaceId)
    .in("task_type", ROUTINE_TASK_TYPES)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const task = data as ScheduledTaskRow;

  const connection = task.source_connection_id
    ? (await loadConnections(workspaceId, [task.source_connection_id])).get(task.source_connection_id)
    : undefined;
  if (task.task_type === "agent_routine") {
    const config = parseAgentRoutineConfig(task.config_json);
    return config ? { task, definition: agentRoutineDefinition(config.title), connection } : null;
  }
  const definition = resolveRoutine(task.task_type, connection?.provider ?? null);
  return definition ? { task, definition, connection } : null;
}

// A parse failure here means the stored schedule is bad (the patch itself was validated).
function safeNextDueAt(task: ScheduledTaskRow, now: Date): string {
  try {
    return computeNextDueAt(task, now).toISOString();
  } catch (error) {
    recordRouteError({
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      operation: "scheduling",
      errorCode: "schedules_invalid_stored_cron",
      error,
    });
    throw new ScheduleServiceError("invalid_schedule");
  }
}

export async function updateRoutine(
  { task, connection }: RoutineTask,
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

  const known = new Map(connection ? [[connection.id, connection]] : []);
  const [routine] = await buildRoutines(task.workspace_id, [data as ScheduledTaskRow], known);
  return routine!;
}

function pickLogged(task: ScheduledTaskRow) {
  return {
    enabled: task.enabled,
    cron: task.cron_expression,
    timezone: task.timezone,
  };
}

const RUN_HISTORY_LIMIT = 50;
const MAX_AGENT_ROUTINES = 20;

/** The newest runs of one routine, or null when the routine does not exist in this workspace. */
export async function listRoutineRuns(workspaceId: string, taskId: string): Promise<RoutineRun[] | null> {
  const { data: task, error: taskError } = await serviceClient
    .from("scheduled_tasks")
    .select("id")
    .eq("id", taskId)
    .eq("workspace_id", workspaceId)
    .eq("task_type", "agent_routine")
    .maybeSingle();
  if (taskError) throw taskError;
  if (!task) return null;

  const { data, error } = await serviceClient
    .from("sessions")
    .select("id, status, end_reason, started_at, ended_at, scheduled_task_id")
    .eq("workspace_id", workspaceId)
    .eq("scheduled_task_id", taskId)
    .order("started_at", { ascending: false })
    .limit(RUN_HISTORY_LIMIT);
  if (error) throw error;
  return ((data ?? []) as RunRow[]).map(toRoutineRun);
}

export async function createAgentRoutine(
  workspaceId: string,
  userId: string,
  input: { config: AgentRoutineConfig; schedule: ScheduleInput },
  now: Date = new Date(),
): Promise<Routine> {
  const built = buildSchedule(input.schedule);
  if (!built.ok) throw new ScheduleServiceError("invalid_schedule", built.field);

  const { count, error: countError } = await serviceClient
    .from("scheduled_tasks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("task_type", "agent_routine");
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_AGENT_ROUTINES) throw new ScheduleServiceError("invalid_schedule", "limit");

  const draft = {
    id: "new",
    workspace_id: workspaceId,
    schedule_kind: "cron",
    cron_expression: built.cron,
    interval_seconds: null,
    timezone: built.timezone,
    next_due_at: null,
  } as unknown as ScheduledTaskRow;

  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .insert({
      workspace_id: workspaceId,
      task_type: "agent_routine",
      task_key: randomUUID(),
      schedule_kind: "cron",
      cron_expression: built.cron,
      timezone: built.timezone,
      enabled: true,
      config_json: input.config,
      next_due_at: safeNextDueAt(draft, now),
      created_by_user_id: userId,
      updated_by_user_id: userId,
    })
    .select("*")
    .single();
  if (error) throw error;

  const [routine] = await buildRoutines(workspaceId, [data as ScheduledTaskRow]);
  return routine!;
}
