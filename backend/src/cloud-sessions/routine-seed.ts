import type { SupabaseClient } from "@supabase/supabase-js";
import { ROUTINE_TRIGGERS } from "draft-core/routines";
import { recordError } from "../errors/record-error";
import { loadDisplayNames } from "../routes/session-display-names";
import { parseAgentRoutineConfig } from "../routines/config";
import { routineRunStartOf, type RoutineRunStart } from "../routines/run-start";
import { routineVisibleTo } from "../routines/visibility";

/** What a continued chat is started from: a finished run of a routine the viewer can see. */
export interface RoutineRunSource {
  routineId: string;
  routineTitle: string;
  /** The first message of the continued chat. It is built from the run's own record, never from the caller's text. */
  prompt: string;
}

export type RoutineRunSourceResult =
  | { ok: true; source: RoutineRunSource }
  | { ok: false; status: 404 | 409; error: "routine_run_not_found" | "routine_run_not_finished" | "routine_run_skipped" }
  | { ok: false; status: 500; error: "routine_run_lookup_failed"; cause: unknown };

interface RunSessionRow {
  id: string;
  session_type: string;
  status: string;
  end_reason: string | null;
  scheduled_task_id: string | null;
  idempotency_key: string | null;
  started_at: string;
  ended_at: string | null;
  deleted_at: string | null;
}

interface RoutineTaskRow {
  id: string;
  visibility: "private" | "shared";
  created_by_user_id: string | null;
  task_type: string;
  config_json: unknown;
  deleted_at: string | null;
}

const RUN_COLUMNS = "id, session_type, status, end_reason, scheduled_task_id, idempotency_key, started_at, ended_at, deleted_at";
const TASK_COLUMNS = "id, visibility, created_by_user_id, task_type, config_json, deleted_at";

const NOT_FOUND: RoutineRunSourceResult = { ok: false, status: 404, error: "routine_run_not_found" };

/**
 * Reads the finished routine run a new chat continues. A run the viewer cannot see, or one that is not a run, is not
 * found. A run still going cannot be continued, since its history is not complete.
 */
export async function loadRoutineRunSource(client: SupabaseClient, workspaceId: string, viewerId: string, routineSessionId: string): Promise<RoutineRunSourceResult> {
  const { data: runData, error: runError } = await client.from("sessions").select(RUN_COLUMNS).eq("id", routineSessionId).eq("workspace_id", workspaceId).maybeSingle();
  if (runError) return lookupFailed(client, workspaceId, runError);
  const run = runData as RunSessionRow | null;
  if (!run || run.deleted_at || run.session_type !== "routine" || !run.scheduled_task_id) return NOT_FOUND;

  const { data: taskData, error: taskError } = await client.from("scheduled_tasks").select(TASK_COLUMNS).eq("id", run.scheduled_task_id).eq("workspace_id", workspaceId).maybeSingle();
  if (taskError) return lookupFailed(client, workspaceId, taskError);
  const task = taskData as RoutineTaskRow | null;
  if (!task || task.deleted_at || task.task_type !== "agent_routine" || !routineVisibleTo(task, viewerId)) return NOT_FOUND;

  if (run.status !== "ended") return { ok: false, status: 409, error: "routine_run_not_finished" };
  // A skipped run never started, so it has no history to continue.
  if (run.end_reason === "skipped") return { ok: false, status: 409, error: "routine_run_skipped" };
  const config = parseAgentRoutineConfig(task.config_json);
  if (!config) return NOT_FOUND;

  const start = routineRunStartOf({ idempotency_key: run.idempotency_key, scheduled_task_id: task.id });
  const startedBy = await startedByLabel(client, workspaceId, routineSessionId, start);
  if (!startedBy.ok) return lookupFailed(client, workspaceId, startedBy.cause);

  const title = config.title.replace(/\s+/g, " ").trim();
  const prompt = routineRunPrompt({
    routineId: task.id,
    routineTitle: title,
    routineSessionId,
    start,
    startedBy: startedBy.label,
    startedAt: run.started_at,
    status: endStatusOf(run),
    endedAt: run.ended_at,
  });
  return { ok: true, source: { routineId: task.id, routineTitle: title, prompt } };
}

async function lookupFailed(client: SupabaseClient, workspaceId: string, cause: unknown): Promise<RoutineRunSourceResult> {
  await recordError({ client, workspaceId, operation: "read", code: "routine_run_lookup_failed", message: "Reading a routine run to continue it failed", error: cause });
  return { ok: false, status: 500, error: "routine_run_lookup_failed", cause };
}

/** Who started the run, in words. A run now names the person who pressed it; the other kinds name what started it. */
async function startedByLabel(
  client: SupabaseClient,
  workspaceId: string,
  routineSessionId: string,
  start: RoutineRunStart,
): Promise<{ ok: true; label: string } | { ok: false; cause: unknown }> {
  if (start.type === "schedule") return { ok: true, label: "the routine's schedule" };
  if (start.type === "event") {
    const label = ROUTINE_TRIGGERS.find((trigger) => trigger.event === start.event)?.label ?? start.event;
    return { ok: true, label: `an event (${label})` };
  }
  const { data, error } = await client.from("agent_runs").select("trigger").eq("session_id", routineSessionId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) return { ok: false, cause: error };
  const requestedBy = (data as { trigger: { requestedBy?: unknown } | null } | null)?.trigger?.requestedBy;
  if (typeof requestedBy !== "string") return { ok: true, label: "a teammate" };
  const names = await loadDisplayNames(client, [requestedBy], []);
  if (!names.ok) return { ok: false, cause: names.detail };
  return { ok: true, label: names.users.get(requestedBy) ?? "a teammate" };
}

function endStatusOf(run: Pick<RunSessionRow, "end_reason">): "completed" | "skipped" | "failed" {
  return run.end_reason === "completed" ? "completed" : run.end_reason === "skipped" ? "skipped" : "failed";
}

const START_REASON: Record<RoutineRunStart["type"], string> = { manual: "run now", schedule: "schedule", event: "event" };

/** The first message of a continued chat. It names the run and says how to read its history, and nothing more. */
export function routineRunPrompt(run: {
  routineId: string;
  routineTitle: string;
  routineSessionId: string;
  start: RoutineRunStart;
  startedBy: string;
  startedAt: string;
  status: string;
  endedAt: string | null;
}): string {
  return [
    "This chat continues the history of a routine run.",
    "",
    `Routine: "${run.routineTitle}" (taskId ${run.routineId})`,
    `Run: sessionId ${run.routineSessionId}`,
    `Start reason: ${START_REASON[run.start.type]}`,
    `Started by: ${run.startedBy}`,
    `Started: ${run.startedAt}`,
    `End status: ${run.status}${run.endedAt ? ` at ${run.endedAt}` : ""}`,
    "",
    "Call `routines.runs` with this routine's `taskId` and `sessionId`, and `transcript: true`. Pass `nextCursor` back as `cursor` for more.",
    "",
    "The user wants to continue this history. Read only what you need.",
  ].join("\n");
}
