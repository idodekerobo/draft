import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import { ROUTINE_HOST_NAME, parseAgentRoutineConfig, routineHostMachineId } from "./config";
import { failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";
import { launchRoutineRun, type LaunchRoutineRun } from "./launch-routine-run";

const UNIQUE_VIOLATION = "23505";

export interface DispatchAgentRoutineOptions {
  task: ScheduledTaskRow;
  occurrenceAt: string;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
  launch?: LaunchRoutineRun;
}

/**
 * Starts one run of a routine. It does nothing when the previous run is still going
 * (a missed occurrence is not caught up) or when this occurrence already has a session.
 * A run that fails to start ends as failed with one error and is not retried:
 * the next scheduled occurrence is the retry.
 */
export async function dispatchAgentRoutine(options: DispatchAgentRoutineOptions): Promise<void> {
  const { task, occurrenceAt, config, client } = options;
  const routine = parseAgentRoutineConfig(task.config_json);
  if (!routine) throw new Error(`agent_routine task ${task.id} has an invalid config`);
  if (!task.created_by_user_id) throw new Error(`agent_routine task ${task.id} has no creator to own its sessions`);

  const { data: running, error: runningError } = await client
    .from("sessions")
    .select("id")
    .eq("workspace_id", task.workspace_id)
    .eq("scheduled_task_id", task.id)
    .in("status", ["starting", "live"])
    .limit(1);
  if (runningError) throw runningError;
  if (running?.length) return;

  // TODO: routine sessions never pass the capture hook, so the brain does not learn from them.
  // Revisit once routines take real actions (write code, send email).
  const sessionId = randomUUID();
  const { error: insertError } = await client
    .from("sessions")
    .insert({
      id: sessionId,
      workspace_id: task.workspace_id,
      owner_user_id: task.created_by_user_id,
      session_type: "routine",
      harness: routine.harness,
      model: routine.model,
      title: routine.title,
      status: "starting",
      host_machine_id: routineHostMachineId(sessionId),
      host_name: ROUTINE_HOST_NAME,
      scheduled_task_id: task.id,
      idempotency_key: `${task.id}:${occurrenceAt}`,
    });
  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) return;
    throw insertError;
  }
  const session: RoutineSessionRef = { id: sessionId, workspace_id: task.workspace_id, scheduled_task_id: task.id, host_machine_id: routineHostMachineId(sessionId) };

  try {
    await (options.launch ?? launchRoutineRun)({ sessionId, workspaceId: task.workspace_id, routine, config, client });
  } catch (error) {
    await failRoutineSession(client, session, {
      code: "routine_launch_failed",
      note: "The run could not start.",
      message: `Routine ${task.id} could not start its run`,
      error,
    });
  }
}
