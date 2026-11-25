import { releaseCodexLeaseForRun } from "../../credentials/codex-credential";
import { captureProductEvent } from "../../observability/product-analytics";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES, runtimeOfTarget, type ExecutionTarget } from "draft-core/run-spec";

/** "local" or "cloud" for analytics, derived from the stored target. Undefined when the row has none. */
function executionRuntime(execution: { target?: { type?: string } } | null): "local" | "cloud" | undefined {
  const type = execution?.target?.type;
  return type ? runtimeOfTarget(type as ExecutionTarget["type"]) : undefined;
}

export interface AgentRunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  failureCode?: string;
  failureDetail?: string;
  /** A short account of what the run did, such as how many items it handled. */
  summary?: string;
}

// A bookkeeping failure must not change what happened to the run, so these log instead of throwing.
function logLifecycleFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ source: "agent_run_lifecycle", event, error: String(error) }));
}

export async function markAgentRunRunning(client: SupabaseClient, runId: string, sandboxMachineId?: string): Promise<void> {
  const { error } = await client
    .from("agent_runs")
    .update({ status: "running", started_at: new Date().toISOString(), ...(sandboxMachineId ? { sandbox_machine_id: sandboxMachineId } : {}) })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (error) logLifecycleFailure("mark_running_failed", error);
}

function outcomeColumns(outcome: AgentRunOutcome) {
  return {
    status: outcome.status,
    completed_at: new Date().toISOString(),
    failure_code: outcome.failureCode ?? null,
    failure_detail: outcome.failureDetail ?? null,
    ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
  };
}

/** Ends a run that has not ended yet. A second call changes nothing. */
export async function finishAgentRun(client: SupabaseClient, runId: string, outcome: AgentRunOutcome): Promise<void> {
  try {
    const { data, error } = await client.from("agent_runs").update(outcomeColumns(outcome)).eq("id", runId).in("status", ACTIVE_AGENT_RUN_STATUSES).select("id, workspace_id, kind, session_id, scheduled_task_id, on_behalf_of_user_id, harness, execution, trigger, completed_at");
    if (error) logLifecycleFailure("finish_failed", error);
    else {
      for (const run of data ?? []) {
        if (run.harness === "codex" && run.kind === "summarization") await releaseCodexLeaseForRun(client, run.workspace_id, run.id);
      }
      await captureCompletedRuns(client, data ?? [], outcome);
    }
  } catch (error) { logLifecycleFailure("finish_failed", error); }
}

/** Ends the active run that streams to this session, if there is one. */
export async function finishAgentRunForSession(client: SupabaseClient, sessionId: string, outcome: AgentRunOutcome): Promise<void> {
  try {
    const { data, error } = await client.from("agent_runs").update(outcomeColumns(outcome)).eq("session_id", sessionId).in("status", ACTIVE_AGENT_RUN_STATUSES).select("id, workspace_id, kind, session_id, scheduled_task_id, on_behalf_of_user_id, harness, execution, trigger, completed_at");
    if (error) logLifecycleFailure("finish_for_session_failed", error);
    else await captureCompletedRuns(client, data ?? [], outcome);
  } catch (error) { logLifecycleFailure("finish_for_session_failed", error); }
}

interface FinishedRun {
  id: string; workspace_id: string; kind: string; session_id: string | null; scheduled_task_id: string | null;
  on_behalf_of_user_id: string | null; harness: string; execution: { target?: { type?: string } } | null; trigger: { type?: string }; completed_at: string;
}
async function captureCompletedRuns(client: SupabaseClient, runs: FinishedRun[], outcome: AgentRunOutcome): Promise<void> {
  for (const run of runs) {
    if (run.kind !== "routine") continue;
    const reason = run.trigger?.type;
    await captureProductEvent(client, "routine_run_completed", {
      userId: run.on_behalf_of_user_id, workspaceId: run.workspace_id, key: run.id, timestamp: run.completed_at,
      properties: { run_id: run.id, routine_id: run.scheduled_task_id, live_session_id: run.session_id,
        run_kind: run.kind, harness: run.harness, runtime: executionRuntime(run.execution),
        start_reason: reason === "cron" ? "schedule" : reason === "event" || reason === "webhook" ? "event" : reason,
        status: outcome.status, error_code: outcome.failureCode },
    });
  }
}
