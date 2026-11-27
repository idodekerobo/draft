import type { SupabaseClient } from "@supabase/supabase-js";
import { eventAudienceForSource, insertEvent } from "./insert-event";
import { onParentRunFinished, type FinishedParentRun } from "../routines/workflow/parent-finished";
import { notifyAdminsOfFailedRun } from "../notify/product/run-result";

/**
 * Records that a routine or synthesis run with steps finished, so Home and later agent runs can see it.
 * The row holds the run id, status and step counts only: no summary text, so a private source's name never enters it.
 */
export async function recordRunResult(client: SupabaseClient, run: FinishedParentRun): Promise<void> {
  const { data: steps, error } = await client.from("agent_runs").select("status").eq("workspace_id", run.workspace_id).eq("parent_run_id", run.id);
  if (error) throw error;
  const stepCounts: Record<string, number> = {};
  for (const step of (steps ?? []) as Array<{ status: string }>) stepCounts[step.status] = (stepCounts[step.status] ?? 0) + 1;

  const audience = await audienceOf(client, run);
  if (!audience) return;
  const label = run.kind === "synthesis" ? "Context update" : "Routine";
  await insertEvent(client, run.workspace_id, {
    event_type: "run_result",
    summary: `${label} ${run.status}`,
    agent_run_id: run.id,
    payload_json: { runId: run.id, kind: run.kind, status: run.status, outcome: run.outcome, stepCounts },
    ...audience,
  });
}

/** A private routine's result is private to the person it ran for. Everything else is the workspace's. */
async function audienceOf(client: SupabaseClient, run: FinishedParentRun) {
  if (run.kind !== "routine") return { visibility: "shared" as const, audience_person_id: null };
  const { data, error } = await client.from("agent_runs").select("scheduled_task_id").eq("id", run.id).maybeSingle();
  if (error) throw error;
  const taskId = (data as { scheduled_task_id: string | null } | null)?.scheduled_task_id;
  if (!taskId) return { visibility: "shared" as const, audience_person_id: null };
  const { data: task, error: taskError } = await client.from("scheduled_tasks").select("visibility, created_by_user_id").eq("id", taskId).maybeSingle();
  if (taskError) throw taskError;
  const row = task as { visibility: "private" | "shared"; created_by_user_id: string | null } | null;
  if (!row) return { visibility: "shared" as const, audience_person_id: null };
  return eventAudienceForSource(client, run.workspace_id, { visibility: row.visibility, owner_user_id: row.created_by_user_id });
}

/** Call once at server start, next to registerWorkflows(). */
export function registerRunResultEvents(): () => void {
  return onParentRunFinished(async (run) => {
    const { serviceClient } = await import("../db/client");
    // The two are independent: a failed event row must not hide a failed run from the admins, and the other way round.
    const results = await Promise.allSettled([recordRunResult(serviceClient, run), failedSynthesisNotice(serviceClient, run)]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  });
}

/** A failed synthesis run tells the admins. A routine's failure is its owner's business and has its own path. */
export async function failedSynthesisNotice(client: SupabaseClient, run: FinishedParentRun): Promise<void> {
  if (run.kind !== "synthesis" || run.status !== "failed") return;
  const { defaultChannels } = await import("../notify/delivery/send");
  await notifyAdminsOfFailedRun(client, defaultChannels(client), run);
}
