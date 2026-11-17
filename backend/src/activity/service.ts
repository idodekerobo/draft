import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRunResults } from "../metaharness/runs/result-line";
import { synthesisTriggerType } from "../synthesis/run-spec";
import { recordRouteError } from "../errors/route-error";
import { routineKind } from "../schedules/kind";
import type { AgentRunRow, ScheduledTaskRow } from "../types/tables";

/** How many runs a page holds. A shorter page is the last one. */
export const ACTIVITY_PAGE_SIZE = 50;

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
}

type Row = Pick<AgentRunRow, "id" | "kind" | "session_id" | "scheduled_task_id" | "status" | "outcome" | "trigger" | "summary" | "started_at" | "completed_at" | "created_at">;
type TaskRow = Pick<ScheduledTaskRow, "id" | "config_json" | "schedule_kind">;
type TitleTaskRow = TaskRow & Pick<ScheduledTaskRow, "visibility" | "created_by_user_id">;
type CreatedTaskRow = TitleTaskRow & Pick<ScheduledTaskRow, "created_by_run_id">;

const titleOf = (task: TaskRow) => (typeof task.config_json.title === "string" ? task.config_json.title : "Routine");

const routineKindOf = (task: TaskRow): ActivityRun["routineKind"] => (task.schedule_kind === "once" ? "once" : "rule");

// config.onSchedule === false marks a routine that runs only on its events.
const createdRoutineKind = (task: CreatedTaskRow): CreatedRoutine["kind"] => routineKind({ ...task, task_type: "agent_routine" });

/** A private routine shows only to the person who made it. */
const viewerMaySee = (task: TitleTaskRow, viewerId: string | null) =>
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

/** Everything the workspace's agents ran, newest first, a page at a time: routines, synthesis, summaries and sessions. */
export async function listActivity(client: SupabaseClient, workspaceId: string, before: Cursor | null, viewerId: string | null): Promise<{ runs: ActivityRun[]; nextCursor: string | null }> {
  let query = client
    .from("agent_runs")
    .select("id, kind, session_id, scheduled_task_id, status, outcome, trigger, summary, started_at, completed_at, created_at")
    .eq("workspace_id", workspaceId);
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
    if (taskIds.length) {
      const found = await client.from("scheduled_tasks").select("id, config_json, schedule_kind, visibility, created_by_user_id").eq("workspace_id", workspaceId).in("id", taskIds).returns<TitleTaskRow[]>();
      if (found.error) throw found.error;
      // Another person's private routine stays a plain "Routine" with no details.
      tasks = new Map((found.data ?? []).filter((task) => viewerMaySee(task, viewerId)).map((task) => [task.id, task]));
    }
    results = await loadRunResults(client, workspaceId, rows.filter((run) => run.kind === "routine"));
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_results_read_failed", error });
  }
  const created = await loadCreatedRoutines(client, workspaceId, rows.map((run) => run.id), viewerId);

  const last = rows[rows.length - 1];
  return {
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
      };
    }),
    nextCursor: rows.length === ACTIVITY_PAGE_SIZE && last ? formatCursor(last.created_at, last.id) : null,
  };
}
