import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";

/** What a listener learns when the run of a routine with steps ends. It never fires for a step run. */
export interface FinishedParentRun {
  id: string;
  kind: string;
  workspace_id: string;
  status: string;
  outcome: string | null;
  on_behalf_of_user_id: string | null;
}

export type ParentRunFinishedListener = (run: FinishedParentRun) => void | Promise<void>;

const listeners: ParentRunFinishedListener[] = [];

/** Adds a listener, such as the sender of a run's result. Returns a function that removes it. */
export function onParentRunFinished(listener: ParentRunFinishedListener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  };
}

/** Tells every listener that a parent run ended. A listener that fails is recorded and never changes the run. */
export async function emitParentRunFinished(client: SupabaseClient, parentRunId: string): Promise<void> {
  if (listeners.length === 0) return;
  const { data, error } = await client
    .from("agent_runs")
    .select("id, kind, workspace_id, status, outcome, on_behalf_of_user_id")
    .eq("id", parentRunId)
    .maybeSingle();
  if (error || !data) return;
  const row = data as FinishedParentRun;
  // Only what the listener contract names, whatever else the row holds.
  const run: FinishedParentRun = { id: row.id, kind: row.kind, workspace_id: row.workspace_id, status: row.status, outcome: row.outcome ?? null, on_behalf_of_user_id: row.on_behalf_of_user_id ?? null };
  for (const listener of [...listeners]) {
    try {
      await listener(run);
    } catch (failure) {
      await recordError({ client, workspaceId: run.workspace_id, agentRunId: run.id, operation: "execution", code: "parent_run_listener_failed", message: "A listener of a finished run failed", error: failure }).catch(() => undefined);
    }
  }
}
