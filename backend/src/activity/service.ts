import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRunResults } from "../metaharness/runs/result-line";
import { synthesisTriggerType } from "../synthesis/run-spec";
import { recordRouteError } from "../errors/route-error";
import type { AgentRunRow } from "../types/tables";

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

export interface ActivityRun {
  id: string;
  kind: AgentRunRow["kind"];
  sessionId: string | null;
  routineId: string | null;
  routineTitle: string | null;
  status: AgentRunRow["status"];
  outcome: AgentRunRow["outcome"];
  triggerType: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

type Row = Pick<AgentRunRow, "id" | "kind" | "session_id" | "scheduled_task_id" | "status" | "outcome" | "trigger" | "summary" | "started_at" | "completed_at" | "created_at">;

/** Everything the workspace's agents ran, newest first, a page at a time: routines, synthesis, summaries and sessions. */
export async function listActivity(client: SupabaseClient, workspaceId: string, before: Cursor | null): Promise<{ runs: ActivityRun[]; nextCursor: string | null }> {
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
  let titles = new Map<string, string>();
  let results = new Map<string, string | null>();
  // A failed lookup only hides titles and results; the runs still list.
  try {
    if (taskIds.length) {
      const tasks = await client.from("scheduled_tasks").select("id, config_json").eq("workspace_id", workspaceId).in("id", taskIds);
      if (tasks.error) throw tasks.error;
      titles = new Map((tasks.data ?? []).map((task) => [task.id, typeof task.config_json?.title === "string" ? task.config_json.title : "Routine"]));
    }
    results = await loadRunResults(client, workspaceId, rows.filter((run) => run.kind === "routine"));
  } catch (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "activity_results_read_failed", error });
  }

  const last = rows[rows.length - 1];
  return {
    runs: rows.map((run) => ({
      id: run.id,
      kind: run.kind,
      sessionId: run.session_id,
      routineId: run.scheduled_task_id,
      routineTitle: run.scheduled_task_id ? titles.get(run.scheduled_task_id) ?? "Routine" : null,
      status: run.status,
      outcome: run.outcome,
      triggerType: synthesisTriggerType(run.trigger),
      resultSummary: results.get(run.id) ?? run.summary,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      createdAt: run.created_at,
    })),
    nextCursor: rows.length === ACTIVITY_PAGE_SIZE && last ? formatCursor(last.created_at, last.id) : null,
  };
}
