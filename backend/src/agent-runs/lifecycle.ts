import type { SupabaseClient } from "@supabase/supabase-js";

const ACTIVE_STATUSES = ["queued", "preparing", "running", "validating", "committing"];

export interface AgentRunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  failureCode?: string;
  failureDetail?: string;
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
    .in("status", ACTIVE_STATUSES);
  if (error) logLifecycleFailure("mark_running_failed", error);
}

function outcomeColumns(outcome: AgentRunOutcome) {
  return {
    status: outcome.status,
    completed_at: new Date().toISOString(),
    failure_code: outcome.failureCode ?? null,
    failure_detail: outcome.failureDetail ?? null,
  };
}

/** Ends a run that has not ended yet. A second call changes nothing. */
export async function finishAgentRun(client: SupabaseClient, runId: string, outcome: AgentRunOutcome): Promise<void> {
  const { error } = await client.from("agent_runs").update(outcomeColumns(outcome)).eq("id", runId).in("status", ACTIVE_STATUSES);
  if (error) logLifecycleFailure("finish_failed", error);
}

/** Ends the active run that streams to this session, if there is one. */
export async function finishAgentRunForSession(client: SupabaseClient, sessionId: string, outcome: AgentRunOutcome): Promise<void> {
  const { error } = await client.from("agent_runs").update(outcomeColumns(outcome)).eq("session_id", sessionId).in("status", ACTIVE_STATUSES);
  if (error) logLifecycleFailure("finish_for_session_failed", error);
}
