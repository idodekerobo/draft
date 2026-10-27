import type { SupabaseClient } from "@supabase/supabase-js";
import { ROUTINE_STALE_AFTER_MS } from "./config";
import { failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";

/** A machine that never reports back leaves its session starting or live. The tick ends it as failed. */
export async function failStaleRoutineSessions(client: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ROUTINE_STALE_AFTER_MS).toISOString();
  const { data, error } = await client
    .from("sessions")
    .select("id, workspace_id, scheduled_task_id, host_machine_id")
    .eq("session_type", "routine")
    .in("status", ["starting", "live"])
    .lt("started_at", cutoff);
  if (error) throw error;

  let failed = 0;
  for (const session of (data ?? []) as RoutineSessionRef[]) {
    const ended = await failRoutineSession(client, session, {
      code: "routine_run_timed_out",
      note: "The run did not finish in time and was stopped.",
      message: "Routine run did not report back before the timeout",
    });
    if (ended) failed += 1;
  }
  return failed;
}
