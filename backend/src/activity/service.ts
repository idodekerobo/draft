import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRunResults } from "../metaharness/runs/result-line";
import { synthesisTriggerType } from "../synthesis/run-spec";
import { recordRouteError } from "../errors/route-error";
import { loadDisplayNames } from "../routes/session-display-names";
import { routineKind } from "../routines/kind";
import type { AgentRunRow, ScheduledTaskRow } from "../types/tables";

/** How many runs a page holds. A shorter page is the last one. */
export const ACTIVITY_PAGE_SIZE = 50;
const UPCOMING_LIMIT = 50;

/** A position in a time-ordered list: "<timestamp>|<id>" of the last item already shown. */
export type Cursor = { at: string; id: string };
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f-]{36})$/i;

export function parseCursor(raw: string | null | undefined): Cursor | null | "invalid" {
  if (!raw) return null;
  const match = CURSOR.exec(raw);
  return match ? { at: match[1]!, id: match[2]! } : "invalid";
}
export const formatCursor = (at: string, id: string) => `${at}|${id}`;

/** A PostgREST filter for the rows after `cursor` in newest-first order. Ties on the timestamp are broken by id. */
export const olderThan = (column: string, cursor: Cursor) => `${column}.lt."${cursor.at}",and(${column}.eq."${cursor.at}",id.lt.${cursor.id})`;

/** A routine that a run made. "event" routines run only on their events and Run now. */
export interface CreatedRoutine {
  id: string;
  title: string;
  kind: "once" | "recurring" | "event";
}

export interface ActivityRun {
  id: string;
  kind: AgentRunRow["kind"];
  sessionId: string | null;
  routineId: string | null;
  routineTitle: string | null;
  /** "once" for a one-time routine, "rule" for one that repeats or runs on events. */
  routineKind: "once" | "rule" | null;
  status: AgentRunRow["status"];
  outcome: AgentRunRow["outcome"];
  triggerType: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdRoutines: CreatedRoutine[];
  /** How many step runs the run started. Zero for a run that has no steps. Open its steps to see them. */
  stepCount: number;
}

/** A one-time routine that has not run yet. setBy is the routine whose run made it, or else the person who set it. */
export interface UpcomingRoutine {
  id: string;
  title: string;
  runAt: string;
  timezone: string;
  setBy: { type: "person"; name: string } | { type: "routine"; routineId: string; title: string };
}

export interface ActivityPage {
  runs: ActivityRun[];
  nextCursor: string | null;
  /** First page only. */
  upcoming?: UpcomingRoutine[];
  /** Set when the upcoming read failed. upcoming is then empty. */
  upcomingError?: true;
}

type Row = Pick<AgentRunRow, "id" | "kind" | "session_id" | "scheduled_task_id" | "status" | "outcome" | "trigger" | "summary" | "started_at" | "completed_at" | "created_at">;
type TaskRow = Pick<ScheduledTaskRow, "id" | "config_json" | "schedule_kind">;
type TitleTaskRow = TaskRow & Pick<ScheduledTaskRow, "visibility" | "created_by_user_id">;
type CreatedTaskRow = TitleTaskRow & Pick<ScheduledTaskRow, "created_by_run_id">;
type UpcomingRow = Pick<ScheduledTaskRow, "id" | "config_json" | "run_at" | "timezone" | "created_via" | "created_by_run_id" | "created_by_user_id">;
const UPCOMING_COLUMNS = "id, config_json, run_at, timezone, created_via, created_by_run_id, created_by_user_id";

export const titleOf = (task: Pick<ScheduledTaskRow, "config_json">) => (typeof task.config_json.title === "string" ? task.config_json.title : "Routine");

const routineKindOf = (task: TaskRow): ActivityRun["routineKind"] => (task.schedule_kind === "once" ? "once" : "rule");

// config.onSchedule === false marks a routine that runs only on its events.
const createdRoutineKind = (task: CreatedTaskRow): CreatedRoutine["kind"] => routineKind({ ...task, task_type: "agent_routine" });

/** A private routine shows only to the person who made it. */
export const viewerMaySee = (task: TitleTaskRow, viewerId: string | null) =>
  task.visibility === "shared" || (viewerId !== null && task.created_by_user_id === viewerId);

/** The routines each run made, keyed by run id. A failed read is recorded and leaves every run with none. */
async function loadCreatedRoutines(client: SupabaseClient, workspaceId: string, runIds: string[], viewerId: string | null): Promise<Map<string, CreatedRoutine[]>> {
  if (!runIds.length) return new Map();
  try {
    const { data, error } = await client
      .from("scheduled_tasks")
      .select("id, config_json, schedule_kind, created_by_run_id, visibility, created_by_user_id")
      .eq("workspace_id", workspaceId)
      .in("created_by_run_id", runIds)
      .order("created_at", { ascending: true })
      .returns<CreatedTaskRow[]>();
    if (error) throw error;
    const created = new Map<string, CreatedRoutine[]>();
    for (const task of data ?? []) {
      if (!task.created_by_run_id || !viewerMaySee(task, viewerId)) continue;
      const routines = created.get(task.created_by_run_id) ?? [];
      routines.push({ id: task.id, title: titleOf(task), kind: createdRoutineKind(task) });
      created.set(task.created_by_run_id, routines);
    }
    return created;
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_created_routines_failed", error });
    return new Map();
  }
}

/** How many step runs each of these runs started. A failed read is recorded and shows every run with none. */
async function loadStepCounts(client: SupabaseClient, workspaceId: string, runIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!runIds.length) return counts;
  try {
    const { data, error } = await client.from("agent_runs").select("parent_run_id").eq("workspace_id", workspaceId).in("parent_run_id", runIds).returns<Array<{ parent_run_id: string }>>();
    if (error) throw error;
    for (const child of data ?? []) counts.set(child.parent_run_id, (counts.get(child.parent_run_id) ?? 0) + 1);
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_step_counts_failed", error });
  }
  return counts;
}

/** The titles and visibility of these routines, unfiltered. Callers decide what the viewer may see. */
export async function loadRoutineTasks(client: SupabaseClient, workspaceId: string, taskIds: string[]): Promise<TitleTaskRow[]> {
  if (!taskIds.length) return [];
  const { data, error } = await client
    .from("scheduled_tasks")
    .select("id, config_json, schedule_kind, visibility, created_by_user_id")
    .eq("workspace_id", workspaceId)
    .in("id", taskIds)
    .returns<TitleTaskRow[]>();
  if (error) throw error;
  return data ?? [];
}

/** Pending one-time routines, soonest first. Throws on a failed read; listActivity records it. */
async function listUpcoming(client: SupabaseClient, workspaceId: string, viewerId: string | null): Promise<UpcomingRoutine[]> {
  let query = client
    .from("scheduled_tasks")
    .select(UPCOMING_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("task_type", "agent_routine")
    .eq("schedule_kind", "once")
    .eq("enabled", true)
    .is("fired_at", null)
    .is("deleted_at", null);
  // Filtering in the query keeps the page full when a teammate's private routines sort first.
  query = viewerId ? query.or(`visibility.eq.shared,created_by_user_id.eq.${viewerId}`) : query.eq("visibility", "shared");
  const { data, error } = await query.order("run_at", { ascending: true }).limit(UPCOMING_LIMIT).returns<UpcomingRow[]>();
  if (error) throw error;
  const tasks = data ?? [];

  const runIds = [...new Set(tasks.flatMap((task) => (task.created_by_run_id ? [task.created_by_run_id] : [])))];
  const routineByRun = new Map<string, string | null>();
  if (runIds.length) {
    const { data: runs, error: runsError } = await client
      .from("agent_runs")
      .select("id, scheduled_task_id")
      .eq("workspace_id", workspaceId)
      .in("id", runIds)
      .returns<Array<Pick<AgentRunRow, "id" | "scheduled_task_id">>>();
    if (runsError) throw runsError;
    for (const run of runs ?? []) routineByRun.set(run.id, run.scheduled_task_id);
  }
  const parentIds = [...new Set([...routineByRun.values()].flatMap((id) => (id ? [id] : [])))];
  const parents = new Map((await loadRoutineTasks(client, workspaceId, parentIds)).map((task) => [task.id, task]));

  const userIds = [...new Set(tasks.flatMap((task) => (task.created_by_user_id ? [task.created_by_user_id] : [])))];
  const names = await loadDisplayNames(client, userIds, []);
  if (!names.ok) throw names.detail;

  return tasks.map((task): UpcomingRoutine => {
    const parentId = task.created_by_run_id ? routineByRun.get(task.created_by_run_id) : null;
    const parent = parentId ? parents.get(parentId) : undefined;
    const setBy: UpcomingRoutine["setBy"] = parentId
      ? { type: "routine", routineId: parentId, title: parent && viewerMaySee(parent, viewerId) ? titleOf(parent) : "Routine" }
      : { type: "person", name: (task.created_by_user_id && names.users.get(task.created_by_user_id)) || "Someone" };
    // The schema's schedule_shape check makes run_at non-null for a once routine.
    return { id: task.id, title: titleOf(task), runAt: task.run_at!, timezone: task.timezone, setBy };
  });
}

/**
 * Everything the workspace's agents ran, newest first, a page at a time: routines, synthesis, summaries and sessions.
 * The first page also lists upcoming one-time routines.
 */
export async function listActivity(client: SupabaseClient, workspaceId: string, before: Cursor | null, viewerId: string | null): Promise<ActivityPage> {
  let query = client
    .from("agent_runs")
    .select("id, kind, session_id, scheduled_task_id, status, outcome, trigger, summary, started_at, completed_at, created_at")
    .eq("workspace_id", workspaceId)
    // One row for each run of a routine. Its step runs are in its details, not in the list.
    .is("parent_run_id", null);
  if (before) query = query.or(olderThan("created_at", before));
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACTIVITY_PAGE_SIZE)
    .returns<Row[]>();
  if (error) throw error;

  const rows = data ?? [];
  const taskIds = [...new Set(rows.flatMap((run) => (run.scheduled_task_id ? [run.scheduled_task_id] : [])))];
  let tasks = new Map<string, TitleTaskRow>();
  let results = new Map<string, string | null>();
  // A failed lookup only hides titles and results; the runs still list.
  try {
    // Another person's private routine stays a plain "Routine" with no details.
    tasks = new Map((await loadRoutineTasks(client, workspaceId, taskIds)).filter((task) => viewerMaySee(task, viewerId)).map((task) => [task.id, task]));
    results = await loadRunResults(client, workspaceId, rows.filter((run) => run.kind === "routine"));
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_results_read_failed", error });
  }
  const created = await loadCreatedRoutines(client, workspaceId, rows.map((run) => run.id), viewerId);
  const stepCounts = await loadStepCounts(client, workspaceId, rows.map((run) => run.id));

  const last = rows[rows.length - 1];
  const page: ActivityPage = {
    runs: rows.map((run) => {
      const routine = run.scheduled_task_id ? tasks.get(run.scheduled_task_id) : undefined;
      return {
        id: run.id,
        kind: run.kind,
        sessionId: run.session_id,
        routineId: run.scheduled_task_id,
        routineTitle: run.scheduled_task_id ? (routine ? titleOf(routine) : "Routine") : null,
        routineKind: routine ? routineKindOf(routine) : null,
        status: run.status,
        outcome: run.outcome,
        triggerType: synthesisTriggerType(run.trigger),
        resultSummary: results.get(run.id) ?? run.summary,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        createdAt: run.created_at,
        createdRoutines: created.get(run.id) ?? [],
        stepCount: stepCounts.get(run.id) ?? 0,
      };
    }),
    nextCursor: rows.length === ACTIVITY_PAGE_SIZE && last ? formatCursor(last.created_at, last.id) : null,
  };
  if (before) return page;
  try {
    return { ...page, upcoming: await listUpcoming(client, workspaceId, viewerId) };
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_upcoming_failed", error });
    return { ...page, upcoming: [], upcomingError: true };
  }
}
