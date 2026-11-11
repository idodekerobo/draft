import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentRun } from "../metaharness/runs/agent-run-store";
import { resolveBaseContextVersionId } from "../metaharness/runs/base-context";
import { markAgentRunRunning } from "../metaharness/runs/lifecycle";
import { PrincipalInactiveError, assertPrincipalActive } from "../metaharness/runs/principal";
import { usableMcpConnections } from "../metaharness/tools/remote-mcp";
import { recordError } from "../errors/record-error";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import { ROUTINE_HOST_NAME, parseAgentRoutineConfig, routineHostMachineId } from "./config";
import { failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";
import { CredentialError } from "../credentials/crypto";
import { describeTaskSchedule } from "../scheduling/describe-task-schedule";
import { RoutineLeaseBusyError, launchRoutineRun, type LaunchRoutineRun } from "./launch-routine-run";
import { buildRoutineRunSpec } from "./run-spec";

const UNIQUE_VIOLATION = "23505";

export interface DispatchAgentRoutineOptions {
  task: ScheduledTaskRow;
  occurrenceAt: string;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
  launch?: LaunchRoutineRun;
}

/**
 * The connections a routine chose that its owner may use now. One that was revoked, or that belongs to
 * someone else, is left out and reported once, so the run goes ahead with the tools it can have.
 */
async function usableMcpServersFor(client: SupabaseClient, task: ScheduledTaskRow, routine: NonNullable<ReturnType<typeof parseAgentRoutineConfig>>) {
  const chosen = routine.environment?.mcpServers ?? [];
  if (chosen.length === 0) return [];
  const usable = await usableMcpConnections(client, task.workspace_id, task.created_by_user_id, chosen.map((server) => server.connectionId));
  const usableIds = new Set(usable.map((connection) => connection.id));
  const skipped = chosen.filter((server) => !usableIds.has(server.connectionId));
  if (skipped.length > 0) {
    await recordError({
      client,
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      operation: "execution",
      message: "A routine's remote tool connection was not available, so the run went ahead without it",
      code: "routine_mcp_connection_unavailable",
      detail: { connection_ids: skipped.map((server) => server.connectionId) },
    });
  }
  return chosen.filter((server) => usableIds.has(server.connectionId));
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
    const contextVersionId = await resolveBaseContextVersionId(client, task.workspace_id);
    const mcpServers = await usableMcpServersFor(client, task, routine);
    const run = buildRoutineRunSpec({
      mcpServers,
      id: randomUUID(),
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      ownerUserId: task.created_by_user_id,
      occurrenceAt,
      routine,
      contextVersionId,
    });
    await assertPrincipalActive(client, run);
    await createAgentRun(client, { spec: run, idempotencyKey: `${task.id}:${occurrenceAt}`, status: "preparing", sessionId });

    const launched = await (options.launch ?? launchRoutineRun)({
      sessionId,
      run,
      workspaceId: task.workspace_id,
      routine,
      schedule: { description: describeTaskSchedule(task), timezone: task.timezone },
      config,
      client,
    });
    await markAgentRunRunning(client, run.id, launched?.machineId);
  } catch (error) {
    if (error instanceof RoutineLeaseBusyError) {
      await failRoutineSession(client, session, {
        code: "routine_run_skipped",
        note: "Another Codex routine was still running, so this run was skipped.",
        message: `Routine ${task.id} was skipped while another Codex run held the login`,
        silent: true,
      });
      return;
    }
    if (error instanceof PrincipalInactiveError) {
      await failRoutineSession(client, session, {
        code: error.code,
        note: "The routine's owner is no longer an active member of this workspace, so the run did not start.",
        message: `Routine ${task.id} was not started: its owner is not an active member`,
        detail: { user_id: task.created_by_user_id },
      });
      return;
    }
    await failRoutineSession(client, session, {
      code: "routine_launch_failed",
      note: error instanceof CredentialError && routine.harness === "codex" ? "Codex is not connected for this workspace. Connect it in Settings." : "The run could not start.",
      message: `Routine ${task.id} could not start its run`,
      error,
    });
  }
}
