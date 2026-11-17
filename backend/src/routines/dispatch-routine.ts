import { randomUUID } from "node:crypto";
import { parseAgentEventId, parseUserId } from "draft-core/run-spec";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentRun } from "../metaharness/runs/agent-run-store";
import { resolveBaseContextVersionId } from "../metaharness/runs/base-context";
import { markAgentRunRunning } from "../metaharness/runs/lifecycle";
import { PrincipalInactiveError, assertPrincipalActive } from "../metaharness/runs/principal";
import { usableMcpConnections } from "../metaharness/tools/remote-mcp";
import { recordError } from "../errors/record-error";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import { describeRoutineTriggers } from "draft-core/routines";
import { ROUTINE_HOST_NAME, parseAgentRoutineConfig, routineHostMachineId, type AgentRoutineConfig } from "./config";
import { failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";
import { CredentialError } from "../credentials/crypto";
import { describeTaskSchedule } from "../scheduling/describe-task-schedule";
import { RoutineLeaseBusyError, launchRoutineRun, type LaunchRoutineRun } from "./launch-routine-run";
import { buildRoutineRunSpec } from "./run-spec";
import type { RoutineEventPayload } from "./event";

const UNIQUE_VIOLATION = "23505";
const LIVE_KEY_INDEX = "sessions_one_live_per_key_idx";

export interface DispatchAgentRoutineOptions {
  task: ScheduledTaskRow;
  occurrenceAt: string;
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
  launch?: LaunchRoutineRun;
  /** Webhook events in this run, oldest first. The run's prompt carries every one of them. */
  events?: RoutineEventPayload[];
  /** "timer", "manual" or an event name. The middle part of the idempotency key. */
  kind: string;
  /** The id of the run's first event, or a unique id for a run that has none. The last part of the idempotency key. */
  firstEventId: string;
  /** Runs with the same key are serialized: one live run per (routine, key). Null lets runs overlap. */
  concurrencyKey: string | null;
  /** The agent_events ids this run consumed. They become the run's trigger. */
  eventIds?: string[];
  /** Set when a person pressed Run now. */
  manual?: { requestedBy: string };
  /** Records the occurrence as skipped instead of running it. The note says why, to anyone who can see the routine. */
  skip?: { code: string; note: string };
}

export type RoutineDispatchOutcome =
  | { status: "started" | "skipped"; sessionId: string; runId: string | null }
  | { status: "busy" | "already_dispatched" | "failed"; sessionId?: string; runId?: string; code?: string };

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

/** How the routine is set to run, in words, for example "Daily at 9:00 AM (UTC), and when a Linear issue is created". */
export function describeRoutineSetup(task: ScheduledTaskRow, routine: Pick<AgentRoutineConfig, "onSchedule" | "events">): string {
  const parts: string[] = [];
  if (routine.onSchedule !== false) parts.push(`${describeTaskSchedule(task)} (${task.timezone})`);
  if (routine.events?.length) parts.push(describeRoutineTriggers(routine.events));
  if (parts.length === 0) return "Only when someone presses Run now";
  return parts.map((part, index) => (index === 0 ? part : part[0]!.toLowerCase() + part.slice(1))).join(", and ");
}

/**
 * Starts one run of a routine. The idempotency key stops the same kind of occurrence from running twice, and
 * the concurrency key makes a run return busy while another run with that key is still live. A run that fails
 * to start ends as failed with one error and is not retried: the next scheduled occurrence is the retry.
 */
export async function dispatchAgentRoutine(options: DispatchAgentRoutineOptions): Promise<RoutineDispatchOutcome> {
  const { task, occurrenceAt, config, client, events, kind, firstEventId, concurrencyKey, eventIds, manual, skip } = options;
  const idempotencyKey = `${task.id}:${kind}:${firstEventId}`;
  const routine = parseAgentRoutineConfig(task.config_json);
  if (!routine) throw new Error(`agent_routine task ${task.id} has an invalid config`);
  if (!task.created_by_user_id) throw new Error(`agent_routine task ${task.id} has no creator to own its sessions`);

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
      reasoning_effort: routine.reasoningEffort ?? null,
      title: routine.title,
      status: "starting",
      host_machine_id: routineHostMachineId(sessionId),
      host_name: ROUTINE_HOST_NAME,
      scheduled_task_id: task.id,
      idempotency_key: idempotencyKey,
      concurrency_key: skip ? null : concurrencyKey,
    });
  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) return insertError.message.includes(LIVE_KEY_INDEX) ? { status: "busy" } : { status: "already_dispatched" };
    throw insertError;
  }
  const session: RoutineSessionRef = { id: sessionId, workspace_id: task.workspace_id, scheduled_task_id: task.id, host_machine_id: routineHostMachineId(sessionId) };
  if (skip) {
    await failRoutineSession(client, session, { ...skip, message: `Routine ${task.id} was skipped`, silent: true });
    return { status: "skipped", sessionId, runId: null };
  }

  try {
    const contextVersionId = await resolveBaseContextVersionId(client, task.workspace_id);
    const mcpServers = await usableMcpServersFor(client, task, routine);
    const trigger = eventIds?.length
      ? { type: "event" as const, eventIds: eventIds.map(parseAgentEventId) }
      : manual
        ? { type: "manual" as const, requestedBy: parseUserId(manual.requestedBy) }
        : undefined;
    const run = buildRoutineRunSpec({
      mcpServers,
      id: randomUUID(),
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      ownerUserId: task.created_by_user_id,
      occurrenceAt,
      ...(trigger ? { trigger } : {}),
      routine,
      contextVersionId,
    });
    await assertPrincipalActive(client, run);
    await createAgentRun(client, { spec: run, idempotencyKey, status: "preparing", sessionId, scheduledTaskId: task.id });

    const launched = await (options.launch ?? launchRoutineRun)({
      sessionId,
      run,
      workspaceId: task.workspace_id,
      routine,
      setup: { description: describeRoutineSetup(task, routine), timezone: task.timezone },
      ...(events?.length ? { events } : {}),
      ...(manual ? { manual: true } : {}),
      config,
      client,
    });
    await markAgentRunRunning(client, run.id, launched?.machineId);
    return { status: "started", sessionId, runId: run.id };
  } catch (error) {
    if (error instanceof RoutineLeaseBusyError) {
      await failRoutineSession(client, session, {
        code: "routine_run_skipped",
        note: "Another Codex routine was still running, so this run was skipped.",
        message: `Routine ${task.id} was skipped while another Codex run held the login`,
        silent: true,
      });
      return { status: "failed", sessionId, code: "routine_lease_busy" };
    }
    if (error instanceof PrincipalInactiveError) {
      await failRoutineSession(client, session, {
        code: error.code,
        note: "The routine's owner is no longer an active member of this workspace, so the run did not start.",
        message: `Routine ${task.id} was not started: its owner is not an active member`,
        detail: { user_id: task.created_by_user_id },
      });
      return { status: "failed", sessionId, code: error.code };
    }
    await failRoutineSession(client, session, {
      code: "routine_launch_failed",
      note: error instanceof CredentialError && routine.harness === "codex" ? "Codex is not connected for this workspace. Connect it in Settings." : "The run could not start.",
      message: `Routine ${task.id} could not start its run`,
      error,
    });
    return { status: "failed", sessionId, code: "routine_launch_failed" };
  }
}
