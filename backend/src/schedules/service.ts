import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ROUTINE_EVENT_NAMES, describeRoutineTriggers, routineProviders, type RoutineEventName, type RoutineListFilter, type RoutineWhen } from "draft-core/routines";
import { recordError } from "../errors/record-error";
import { recordRouteError } from "../errors/route-error";
import { drainEventInbox } from "../events/drain";
import { enqueueEvent } from "../events/enqueue";
import type { AgentEventRow } from "../events/types";
import { formatCursor, olderThan, type Cursor } from "../activity/service";
import { loadDisplayNames } from "../routes/session-display-names";
import { describeTaskSchedule } from "../scheduling/describe-task-schedule";
import { computeNextDueAt } from "../scheduling/next-due-at";
import {
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
import type { AgentRunRow, ScheduledTaskRow, SessionRow, SourceConnectionRow } from "../types/tables";
import type { SchedulePatch } from "./validate-patch";
import { canEditSchedules } from "./permissions";
import type { RoutineCreator } from "./creator";
import { resolveWhen, type ResolvedWhen, type WhenRefusal } from "./when";
import { loadRunResults } from "../metaharness/runs/result-line";
import { serviceClient } from "../db/client";
import { routineKind, runsOnSchedule, type RoutineKind } from "./kind";

const LIVE_CONNECTION_STATUSES = new Set(["active", "degraded"]);

export interface RoutineLastRun {
  status: AgentRunRow["status"];
  outcome: AgentRunRow["outcome"];
  completedAt: string | null;
}

export type RoutineRunStatus = "running" | "completed" | "failed" | "skipped";

export type RoutineRunStart = { type: "schedule" } | { type: "run_now" } | { type: "event"; event: RoutineEventName };

export interface RoutineRun {
  id: string;
  status: RoutineRunStatus;
  startedBy: RoutineRunStart;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  /** Why a skipped run did not run, in words for people. */
  skipReason?: string | null;
}

export interface AgentRoutineInfo extends Omit<AgentRoutineConfig, "title"> {
  createdByName: string | null;
  lastRun: RoutineRun | null;
  /** Connections its triggers or access need that the workspace no longer has. Those triggers never fire. */
  missingConnections: string[];
}

/** once fires one time. recurring runs on its schedule. event is started only by its triggers and Run now. */
export type { RoutineKind } from "./kind";

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
  kind: RoutineKind;
  runAt: string | null;
  firedAt: string | null;
  createdVia: ScheduledTaskRow["created_via"];
  createdByRunId: string | null;
  /** Made through MCP or by a Draft run, not by a person in the app. */
  madeByAgent: boolean;
  visibility: ScheduledTaskRow["visibility"];
  editable: RoutineEditability;
  canEdit: boolean;
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
type RunInfo = Pick<AgentRunRow, "status" | "outcome" | "completed_at">;

export type ScheduleErrorCode = "not_found" | "forbidden" | WhenRefusal["code"];

export class ScheduleServiceError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    readonly field?: string,
    message: string = code,
  ) {
    super(message);
  }
}

const CHANGE_KIND_MESSAGE = "A routine can't change between once and repeating.";
const DEFAULT_OFF_SCHEDULE = { cron: "0 9 * * *", timezone: "UTC" };

function resolveWhenOrThrow(when: RoutineWhen, now: Date): ResolvedWhen {
  const result = resolveWhen(when, now);
  if (!result.ok) throw new ScheduleServiceError(result.code, result.field, result.message);
  return result.value;
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
    scheduleDescription: describeTaskSchedule(task),
    preset: parsed.preset,
    time: parsed.time,
    weekday: parsed.weekday,
    timezone: task.timezone,
    cron: task.schedule_kind === "cron" ? task.cron_expression : null,
    intervalSeconds: task.schedule_kind === "interval" ? task.interval_seconds : null,
    enabled: task.enabled,
    kind: routineKind(task),
    runAt: task.run_at ?? null,
    firedAt: task.fired_at ?? null,
    createdVia: task.created_via,
    createdByRunId: task.created_by_run_id ?? null,
    madeByAgent: task.created_via === "mcp" || task.created_via === "run",
    visibility: task.visibility,
    editable: definition.editable,
    canEdit: false,
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

const RUN_COLUMNS = "id, status, end_reason, started_at, ended_at, scheduled_task_id, idempotency_key";

type RunRow = Pick<SessionRow, "id" | "status" | "end_reason" | "started_at" | "ended_at" | "idempotency_key"> & { scheduled_task_id: string };

/** Read from the run's idempotency key, which dispatch writes as "<task>:<occurrence>", "<task>:manual:<id>" or "<task>:<event>:<id>". */
function startedBy(row: RunRow): RoutineRunStart {
  const rest = row.idempotency_key?.slice(row.scheduled_task_id.length + 1) ?? "";
  if (rest.startsWith("manual:")) return { type: "run_now" };
  const event = ROUTINE_EVENT_NAMES.find((name) => rest.startsWith(`${name}:`));
  return event ? { type: "event", event } : { type: "schedule" };
}

function toRoutineRun(row: RunRow): RoutineRun {
  const status: RoutineRunStatus =
    row.status !== "ended" ? "running" : row.end_reason === "completed" ? "completed" : row.end_reason === "skipped" ? "skipped" : "failed";
  return { id: row.id, status, startedBy: startedBy(row), startedAt: row.started_at, endedAt: row.ended_at, result: null };
}

/** Adds the note each skipped run ended with, which says why it was skipped. */
async function withSkipReasons(workspaceId: string, runs: RoutineRun[]): Promise<RoutineRun[]> {
  const skipped = runs.filter((run) => run.status === "skipped").map((run) => run.id);
  if (skipped.length === 0) return runs;
  const { data, error } = await serviceClient
    .from("session_events")
    .select("session_id, payload")
    .eq("workspace_id", workspaceId)
    .eq("source_id", "routine:failed")
    .in("session_id", skipped);
  if (error) {
    recordRouteError({ workspaceId, errorCode: "schedules_skip_reasons_failed", error });
    return runs;
  }
  const notes = new Map(((data ?? []) as Array<{ session_id: string; payload: { text?: unknown } }>).map((row) => [row.session_id, typeof row.payload?.text === "string" ? row.payload.text : null]));
  return runs.map((run) => (run.status === "skipped" ? { ...run, skipReason: notes.get(run.id) ?? null } : run));
}

async function loadTasks(workspaceId: string): Promise<ScheduledTaskRow[]> {
  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .select("*")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("task_type", ROUTINE_TASK_TYPES)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTaskRow[];
}

async function loadConnections(workspaceId: string, ids: string[], client: SupabaseClient = serviceClient): Promise<Map<string, ConnectionInfo>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await client
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
    .from("agent_runs")
    .select("status, outcome, completed_at")
    .eq("kind", "synthesis")
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
  // One small query per routine: a busy routine cannot crowd another out of a shared page.
  const rows = await Promise.all(
    taskIds.map(async (taskId) => {
      const { data, error } = await serviceClient
        .from("sessions")
        .select(RUN_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("scheduled_task_id", taskId)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) {
        recordRouteError({ workspaceId, errorCode: "schedules_last_agent_run_failed", error });
        return null;
      }
      return ((data ?? []) as RunRow[])[0] ?? null;
    }),
  );
  const present = rows.filter((row): row is RunRow => row !== null);
  const runs = await withSkipReasons(workspaceId, present.map(toRoutineRun));
  return new Map(present.map((row, index) => [row.scheduled_task_id, runs[index]!] as const));
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

  const [connections, lastRun, names, lastAgentRuns, connectedProviders] = await Promise.all([
    knownConnections ?? loadConnections(workspaceId, connectionIds),
    hasSynthesis ? loadLastSynthesisRun(workspaceId) : Promise.resolve(null),
    loadUserNames(workspaceId, editorIds),
    loadLastAgentRuns(workspaceId, agentTaskIds),
    agentTaskIds.length ? listConnectedProviders(workspaceId) : Promise.resolve([]),
  ]);

  return tasks.flatMap((task) => {
    if (task.task_type === "agent_routine") {
      const config = parseAgentRoutineConfig(task.config_json);
      if (!config) {
        console.warn(`Skipping scheduled task ${task.id}: invalid agent routine config`);
        return [];
      }
      const { title: _title, ...agentConfig } = config;
      const agent: AgentRoutineInfo = {
        ...agentConfig,
        createdByName: task.created_by_user_id ? (names.get(task.created_by_user_id) ?? null) : null,
        lastRun: lastAgentRuns.get(task.id) ?? null,
        missingConnections: routineProviders(config).filter((provider) => !connectedProviders.includes(provider)),
      };
      const routine = toRoutine(
        task,
        agentRoutineDefinition(config.title),
        undefined,
        null,
        task.updated_by_user_id ? (names.get(task.updated_by_user_id) ?? null) : null,
        agent,
      );
      return [config.onSchedule === false ? { ...routine, scheduleDescription: describeRoutineTriggers(config.events ?? []) } : routine];
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

/** Private routines are visible only to their creator. One-time routines are listed only when asked for by kind. */
function matchesFilter(task: ScheduledTaskRow, callerId: string | undefined, filter: RoutineListFilter): boolean {
  if (task.visibility === "private" && task.created_by_user_id !== callerId) return false;
  const kind = routineKind(task);
  // One-shots are hidden by default, but asking for one by id finds it.
  if (filter.kind !== undefined ? kind !== filter.kind : kind === "once" && filter.taskId === undefined) return false;
  if (filter.status === "upcoming" && task.fired_at != null) return false;
  if (filter.status === "fired" && task.fired_at == null) return false;
  if (filter.createdBy === "me" && task.created_by_user_id !== callerId) return false;
  if (filter.taskId !== undefined && task.id !== filter.taskId) return false;
  return true;
}

export async function listRoutines(workspaceId: string, callerId?: string, filter: RoutineListFilter = {}): Promise<Routine[]> {
  const tasks = (await loadTasks(workspaceId)).filter((task) => matchesFilter(task, callerId, filter));
  const routines = await buildRoutines(workspaceId, tasks);
  if (!callerId) return routines;
  const canEdit = await canEditSchedules(workspaceId, callerId);
  return routines.map((routine) => ({ ...routine, canEdit }));
}

export interface RoutineTask {
  task: ScheduledTaskRow;
  definition: RoutineDefinition;
  connection: ConnectionInfo | undefined;
}

/** A private routine is visible only to the person who made it. A null viewer sees shared routines only. */
export const routineVisibleTo = (task: Pick<ScheduledTaskRow, "visibility" | "created_by_user_id">, viewerId: string | null) =>
  task.visibility !== "private" || (viewerId !== null && task.created_by_user_id === viewerId);

/** Pass viewerId to hide another person's private routine, as if it did not exist. */
export async function getRoutineTask(workspaceId: string, taskId: string, client: SupabaseClient = serviceClient, viewerId?: string | null): Promise<RoutineTask | null> {
  const { data, error } = await client
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("task_type", ROUTINE_TASK_TYPES)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const task = data as ScheduledTaskRow;
  if (viewerId !== undefined && !routineVisibleTo(task, viewerId)) return null;

  const connection = task.source_connection_id
    ? (await loadConnections(workspaceId, [task.source_connection_id], client)).get(task.source_connection_id)
    : undefined;
  if (task.task_type === "agent_routine") {
    const config = parseAgentRoutineConfig(task.config_json);
    return config ? { task, definition: agentRoutineDefinition(config.title), connection } : null;
  }
  const definition = resolveRoutine(task.task_type, connection?.provider ?? null);
  return definition ? { task, definition, connection } : null;
}

/** Providers the workspace has a live connection to. The routine form offers triggers and abilities from these. */
export async function listConnectedProviders(workspaceId: string): Promise<string[]> {
  const { data, error } = await serviceClient.from("source_connections").select("provider, status").eq("workspace_id", workspaceId);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ provider: string; status: string }>;
  // A pending connection has its credentials; Fireflies and Granola stay pending until their first webhook.
  return [...new Set(rows.filter((row) => LIVE_CONNECTION_STATUSES.has(row.status) || row.status === "pending").map((row) => row.provider))].sort();
}


// A parse failure here means the stored schedule is bad (the patch itself was validated).
function safeNextDueAt(task: ScheduledTaskRow, now: Date): string | null {
  try {
    return computeNextDueAt(task, now)?.toISOString() ?? null;
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
  if (!(await canEditSchedules(task.workspace_id, userId))) throw new ScheduleServiceError("forbidden");
  const changes: Partial<ScheduledTaskRow> = {};
  if (patch.enabled !== undefined) changes.enabled = patch.enabled;
  if (patch.agent) changes.config_json = { ...patch.agent };

  const resolved = patch.when ? resolveWhenOrThrow(patch.when, now) : null;
  if (resolved?.kind === "once") {
    if (task.schedule_kind !== "once") throw new ScheduleServiceError("invalid_schedule", "when", CHANGE_KIND_MESSAGE);
    const enabled = patch.enabled ?? true;
    const runAt = resolved.runAt.toISOString();
    changes.enabled = enabled;
    changes.run_at = runAt;
    changes.fired_at = null;
    changes.next_due_at = enabled ? runAt : null;
  }
  if (!resolved && patch.enabled === true && task.schedule_kind === "once" && task.fired_at) {
    throw new ScheduleServiceError("invalid_schedule", "when", "This one-time routine already ran. Give it a new time to run it again.");
  }
  if (resolved?.kind === "rule") {
    if (task.schedule_kind === "once") throw new ScheduleServiceError("invalid_schedule", "when", CHANGE_KIND_MESSAGE);
    const { schedule, events } = resolved;
    if (schedule) {
      changes.schedule_kind = "cron";
      changes.cron_expression = schedule.cron;
      changes.interval_seconds = null;
      changes.timezone = schedule.timezone;
    }
    if (task.task_type === "agent_routine" && (schedule !== undefined || events !== undefined)) {
      const config: Record<string, unknown> = { ...(changes.config_json ?? task.config_json) };
      if (schedule === null) config.onSchedule = false;
      if (schedule) delete config.onSchedule;
      if (events !== undefined) config.events = events;
      changes.config_json = config;
    }
  }

  const next = { ...task, ...changes };
  const resumes = patch.enabled === true && !task.enabled;
  const scheduleTurnedOn = runsOnSchedule(next) && !runsOnSchedule(task);
  const scheduleSet = resolved?.kind === "rule" && resolved.schedule !== undefined;
  if (!runsOnSchedule(next)) changes.next_due_at = null;
  else if (next.enabled && (scheduleSet || resumes || scheduleTurnedOn)) changes.next_due_at = safeNextDueAt(next, now);

  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .update({ ...changes, updated_by_user_id: userId })
    .eq("id", task.id)
    .eq("workspace_id", task.workspace_id)
    .select("*")
    .maybeSingle();
  if (error) {
    await recordError({
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      operation: "commit",
      code: "routine_update_failed",
      message: "Updating a routine failed",
      detail: { fields: Object.keys(changes) },
      error,
    });
    throw error;
  }
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

/** Hides the routine and stops its runs. The row stays, because its past runs point at it. */
export async function deleteRoutine({ task }: RoutineTask, userId: string, now: Date = new Date()): Promise<void> {
  if (!(await canEditSchedules(task.workspace_id, userId))) throw new ScheduleServiceError("forbidden");
  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .update({ deleted_at: now.toISOString(), enabled: false, updated_by_user_id: userId })
    .eq("id", task.id)
    .eq("workspace_id", task.workspace_id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ScheduleServiceError("not_found");

  console.log(JSON.stringify({ event: "schedule_deleted", workspaceId: task.workspace_id, taskId: task.id, userId }));
}

/** `queued` means the run starts when the run in progress ends, or when the inbox next drains. */
export type RunNowOutcome =
  | { status: "started"; runId: string; sessionId: string }
  | { status: "queued" }
  | { status: "failed"; code: string };

export interface RunNowDeps {
  client?: SupabaseClient;
  enqueue?: typeof enqueueEvent;
  drain?: () => Promise<void>;
}

interface RunNowScope {
  client: SupabaseClient;
  workspaceId: string;
  taskId: string;
}

type RunNowEvent = Pick<AgentEventRow, "status" | "claimed_by_run_id" | "failure_code">;
type RunNowDetails = { error?: unknown; detail?: Record<string, unknown>; agentRunId?: string };

async function recordRunNow(scope: RunNowScope, code: string, message: string, details: RunNowDetails = {}): Promise<void> {
  await recordError({ client: scope.client, workspaceId: scope.workspaceId, scheduledTaskId: scope.taskId, operation: "scheduling", code, message, ...details });
}

/** Records a failure this call found and reports it. A dispatch that failed has its own error row and is not passed here. */
async function failRunNow(scope: RunNowScope, code: string, message: string, details: RunNowDetails = {}): Promise<RunNowOutcome> {
  await recordRunNow(scope, code, message, details);
  return { status: "failed", code };
}

/**
 * Puts one manual event in the inbox and drains it. The event then says whether the run started or waits
 * behind a run in progress. A failed drain is recorded, and the event still says where the run stands.
 */
export async function runRoutineNow(workspaceId: string, taskId: string, userId: string, deps: RunNowDeps = {}): Promise<RunNowOutcome> {
  const client = deps.client ?? serviceClient;
  const routine = await getRoutineTask(workspaceId, taskId, client, userId);
  if (!routine || routine.task.task_type !== "agent_routine") throw new ScheduleServiceError("not_found");
  if (!(await canEditSchedules(workspaceId, userId))) throw new ScheduleServiceError("forbidden");
  const scope: RunNowScope = { client, workspaceId, taskId };

  // The drain below runs the event, so the enqueue must not start a drain of its own.
  let eventId: string | null = null;
  try {
    eventId = (
      await (deps.enqueue ?? enqueueEvent)(
        client,
        {
          workspaceId,
          scheduledTaskId: taskId,
          origin: "manual",
          eventName: "manual",
          dedupeKey: `${taskId}:manual:${randomUUID()}`,
          concurrencyKey: taskId,
          payload: { type: "manual", requestedBy: userId },
        },
        { drain: async () => {} },
      )
    ).id;
  } catch (error) {
    return failRunNow(scope, "event_enqueue_failed", "Storing the run request failed", { error });
  }
  if (!eventId) return failRunNow(scope, "event_enqueue_failed", "The run request was not stored", { detail: { duplicate: true } });

  try {
    await (deps.drain ?? (() => drainEventInbox()))();
  } catch (error) {
    await recordRunNow(scope, "event_drain_failed", "Draining the event inbox failed during Run now", { error, detail: { event_id: eventId } });
  }

  const { data, error } = await client.from("agent_events").select("status, claimed_by_run_id, failure_code").eq("id", eventId).maybeSingle();
  const event = data as RunNowEvent | null;
  if (error || !event) return failRunNow(scope, "event_read_failed", "Reading the run request back failed", { error, detail: { event_id: eventId } });

  if (event.status === "pending" || event.status === "claimed") return { status: "queued" };
  if (event.status === "done") {
    const runId = event.claimed_by_run_id;
    if (!runId) return { status: "queued" };
    const { data: run, error: runError } = await client.from("agent_runs").select("session_id").eq("id", runId).eq("workspace_id", workspaceId).maybeSingle();
    const sessionId = (run as Pick<AgentRunRow, "session_id"> | null)?.session_id;
    if (runError || !sessionId) return failRunNow(scope, "run_lookup_failed", "Reading the started run failed", { error: runError, agentRunId: runId, detail: { event_id: eventId } });
    return { status: "started", runId, sessionId };
  }
  return { status: "failed", code: event.failure_code ?? "run_failed" };
}

function pickLogged(task: ScheduledTaskRow) {
  return {
    enabled: task.enabled,
    cron: task.cron_expression,
    timezone: task.timezone,
  };
}

const RUN_HISTORY_LIMIT = 50;

/**
 * One routine's runs, newest first, a page at a time; or, with `runId`, just that run, however old. Null when the
 * routine does not exist in this workspace.
 */
export async function listRoutineRuns(
  workspaceId: string,
  taskId: string,
  options: { before?: Cursor | null; runId?: string; viewerId?: string | null } = {},
): Promise<{ runs: RoutineRun[]; nextCursor: string | null } | null> {
  const { data: task, error: taskError } = await serviceClient
    .from("scheduled_tasks")
    .select("id, visibility, created_by_user_id")
    .eq("id", taskId)
    .eq("workspace_id", workspaceId)
    .eq("task_type", "agent_routine")
    .is("deleted_at", null)
    .maybeSingle();
  if (taskError) throw taskError;
  if (!task) return null;
  if (options.viewerId !== undefined && !routineVisibleTo(task as Pick<ScheduledTaskRow, "visibility" | "created_by_user_id">, options.viewerId)) return null;

  let query = serviceClient.from("sessions").select(RUN_COLUMNS).eq("workspace_id", workspaceId).eq("scheduled_task_id", taskId);
  if (options.runId) query = query.eq("id", options.runId);
  else if (options.before) query = query.or(olderThan("started_at", options.before));
  const { data, error } = await query
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(RUN_HISTORY_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as RunRow[];
  const { data: runs, error: runsError } = await serviceClient.from("agent_runs").select("id, session_id, summary").eq("workspace_id", workspaceId).in("session_id", rows.map((row) => row.id));
  if (runsError) throw runsError;
  const runRows = (runs ?? []) as Array<{ id: string; session_id: string; summary: string | null }>;
  const results = await loadRunResults(serviceClient, workspaceId, runRows.map(({ id, summary }) => ({ id, summary })));
  const runBySession = new Map(runRows.map((run) => [run.session_id, run.id]));
  const last = rows[rows.length - 1];
  return {
    runs: await withSkipReasons(workspaceId, rows.map((row) => ({ ...toRoutineRun(row), result: results.get(runBySession.get(row.id) ?? "") ?? null }))),
    nextCursor: !options.runId && rows.length === RUN_HISTORY_LIMIT && last ? formatCursor(last.started_at, last.id) : null,
  };
}

/**
 * A once keeps its one time. A rule keeps its schedule, or the default one while the schedule is off, so turning
 * it back on is one edit.
 */
export async function createAgentRoutine(
  workspaceId: string,
  creator: RoutineCreator,
  input: { config: AgentRoutineConfig; when: RoutineWhen; enabled?: boolean },
  now: Date = new Date(),
): Promise<Routine> {
  if (!(await canEditSchedules(workspaceId, creator.userId))) throw new ScheduleServiceError("forbidden");
  const resolved = resolveWhenOrThrow(input.when, now);
  const enabled = input.enabled ?? true;

  let timing: Record<string, unknown>;
  if (resolved.kind === "once") {
    const runAt = resolved.runAt.toISOString();
    timing = {
      schedule_kind: "once",
      run_at: runAt,
      cron_expression: null,
      interval_seconds: null,
      timezone: resolved.timezone,
      next_due_at: enabled ? runAt : null,
    };
  } else {
    const schedule = resolved.schedule ?? DEFAULT_OFF_SCHEDULE;
    const draft = {
      id: "new",
      workspace_id: workspaceId,
      schedule_kind: "cron",
      cron_expression: schedule.cron,
      interval_seconds: null,
      timezone: schedule.timezone,
      next_due_at: null,
    } as unknown as ScheduledTaskRow;
    timing = {
      schedule_kind: "cron",
      cron_expression: schedule.cron,
      interval_seconds: null,
      timezone: schedule.timezone,
      next_due_at: enabled && input.config.onSchedule !== false ? safeNextDueAt(draft, now) : null,
    };
  }

  const { data, error } = await serviceClient
    .from("scheduled_tasks")
    .insert({
      workspace_id: workspaceId,
      task_type: "agent_routine",
      task_key: randomUUID(),
      enabled,
      config_json: input.config,
      ...timing,
      created_by_user_id: creator.userId,
      updated_by_user_id: creator.userId,
      created_via: creator.via,
      created_by_run_id: creator.runId,
      trigger_depth: creator.depth,
      visibility: creator.visibility,
    })
    .select("*")
    .single();
  if (error) {
    await recordError({
      workspaceId,
      operation: "commit",
      code: "routine_create_failed",
      message: "Creating a routine failed",
      detail: { schedule_kind: timing.schedule_kind, created_via: creator.via },
      error,
    });
    throw error;
  }

  const [routine] = await buildRoutines(workspaceId, [data as ScheduledTaskRow]);
  return routine!;
}
