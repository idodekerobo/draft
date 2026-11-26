import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { ROUTINE_STALE_AFTER_MS } from "./config";
import { failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";

const STALE_BATCH = 50;

/** The sessions whose run has a step run queued or going. */
async function sessionsWithActiveStepRuns(client: SupabaseClient, sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { data: parents, error } = await client.from("agent_runs").select("id, session_id").in("session_id", sessionIds).eq("kind", "routine");
  if (error) throw error;
  const bySession = new Map(((parents ?? []) as Array<{ id: string; session_id: string }>).map((parent) => [parent.id, parent.session_id]));
  if (bySession.size === 0) return new Set();
  const { data: children, error: childError } = await client.from("agent_runs").select("parent_run_id").in("parent_run_id", [...bySession.keys()]).in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (childError) throw childError;
  return new Set(((children ?? []) as Array<{ parent_run_id: string }>).flatMap((child) => bySession.get(child.parent_run_id) ?? []));
}

/** A machine that never reports back leaves its session starting or live. The tick ends it as failed. */
export async function failStaleRoutineSessions(client: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ROUTINE_STALE_AFTER_MS).toISOString();
  const { data, error } = await client
    .from("sessions")
    .select("id, workspace_id, scheduled_task_id, host_id")
    .eq("session_type", "routine")
    .in("status", ["starting", "live"])
    .lt("started_at", cutoff)
    .limit(STALE_BATCH);
  if (error) throw error;

  const stale = (data ?? []) as RoutineSessionRef[];
  const stepping = await sessionsWithActiveStepRuns(client, stale.map((session) => session.id));

  let failed = 0;
  for (const session of stale) {
    // A routine with steps starts no process of its own for the session. It is stale only once none of its step runs is going.
    if (stepping.has(session.id)) continue;
    const ended = await failRoutineSession(client, session, {
      code: "routine_run_timed_out",
      note: "The run did not finish in time and was stopped.",
      message: "Routine run did not report back before the timeout",
    });
    if (ended) failed += 1;
  }
  return failed;
}
