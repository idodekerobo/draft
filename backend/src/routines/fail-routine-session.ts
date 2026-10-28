import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import type { SessionRow } from "../types/tables";

export type RoutineSessionRef = Pick<SessionRow, "id" | "workspace_id" | "scheduled_task_id" | "host_machine_id">;

export interface RoutineFailure {
  code: string;
  /** Shown to people in the session view, so it must not carry internal detail. */
  note: string;
  message: string;
  detail?: Record<string, unknown>;
  error?: unknown;
}

/** Moves a running session to ended. Returns false when it had already ended, so only one caller records the outcome. */
export async function endRoutineSession(
  client: SupabaseClient,
  session: Pick<RoutineSessionRef, "id" | "workspace_id">,
  endReason: "completed" | "failed",
): Promise<boolean> {
  const { data, error } = await client
    .from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: endReason, open_approval_count: 0 })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .neq("status", "ended")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Ends a routine session as failed and writes one errors row. There is no retry:
 * the next scheduled run is the retry. Only the call that moves the session out of
 * a running state writes the row, so a late timeout and a runner report cannot
 * both record the same failure.
 */
export async function failRoutineSession(
  client: SupabaseClient,
  session: RoutineSessionRef,
  failure: RoutineFailure,
): Promise<boolean> {
  // The note goes in first because an ended session rejects appends. It is best effort.
  await client
    .rpc("append_session_events", {
      p_session_id: session.id,
      p_workspace_id: session.workspace_id,
      p_host_machine_id: session.host_machine_id,
      p_events: [{ source_id: "routine:failed", kind: "session_note", payload: { text: failure.note } }],
    })
    .then(() => undefined, () => undefined);

  if (!(await endRoutineSession(client, session, "failed"))) return false;

  await recordError({
    client,
    workspaceId: session.workspace_id,
    sessionId: session.id,
    scheduledTaskId: session.scheduled_task_id,
    operation: "session",
    message: failure.message,
    code: failure.code,
    detail: failure.detail,
    error: failure.error,
  });
  return true;
}
