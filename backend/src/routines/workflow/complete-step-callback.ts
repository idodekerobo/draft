import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES, type StepParentKind } from "draft-core/run-spec";
import { recordError } from "../../errors/record-error";
import { saveRunUsage } from "../../metaharness/runs/save-run-usage";
import { authenticateSandboxCallbackRequest, type SandboxDeploymentConfig } from "../../metaharness/sandbox";
import { completeRunCredentials } from "../../metaharness/sandbox/launch-with-credentials";
import type { AgentRunRow } from "../../types/tables";
import { advanceWorkflow } from "./advance";
import { workflowFor } from "./registry";
import { failStepRun } from "./step-failure";
import type { EngineDeps, WorkflowKind } from "./types";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The failure category a runner reports, such as `rate_limit`, from its failure result. */
function categoryOf(result: Record<string, unknown>): string | null {
  const diagnostics = result.diagnostics;
  const category = isObject(diagnostics) ? diagnostics.failureCategory : null;
  return typeof category === "string" && category !== "none" ? category : null;
}

/** Saves a step run's answer and ends it. False when it had already ended, so a late callback changes nothing. */
async function succeedStepRun(client: SupabaseClient, runId: string, result: Record<string, unknown>): Promise<boolean> {
  const summary = typeof result.summary === "string" ? result.summary : null;
  const { data, error } = await client
    .from("agent_runs")
    .update({ status: "succeeded", result_json: result, completed_at: new Date().toISOString(), ...(summary ? { summary } : {}) })
    .eq("id", runId)
    .eq("kind", "step")
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Receives what a step run's sandbox reports: its answer, or the reason it failed. A step run has no session. It
 * saves the transcript and the usage, ends the run, and then lets the engine move the parent run on. A late callback
 * for a run that was already ended (by the sweep, for example) changes nothing.
 */
export async function completeStepRunCallback(
  request: Request,
  config: SandboxDeploymentConfig,
  client?: SupabaseClient,
  options: { resolveWorkflow?: (kind: StepParentKind) => WorkflowKind; launch?: EngineDeps["launch"] } = {},
): Promise<Response> {
  const resolveWorkflow = options.resolveWorkflow ?? workflowFor;
  const db = client ?? (await import("../../db/client")).serviceClient;
  const authenticated = await authenticateSandboxCallbackRequest(request, config.callbackSecret);
  const { data, error } = await db.from("agent_runs").select("*").eq("id", authenticated.runId).eq("kind", "step").maybeSingle();
  if (error) throw error;
  const run = data as AgentRunRow | null;
  if (!run || !run.parent_run_id) return new Response(null, { status: 404 });

  // Keeps the Codex login: saved and released before anything else, so it is never left leased.
  await completeRunCredentials(db, run.id, authenticated.authJson);
  if (authenticated.transcript !== undefined) {
    const { error: transcriptError } = await db.from("agent_runs").update({ transcript_json: authenticated.transcript }).eq("id", run.id);
    if (transcriptError) console.error("completeStepRunCallback: transcript_json update failed", transcriptError);
  }
  await saveRunUsage(db, { runId: run.id }, authenticated.usage);

  const result = authenticated.result;
  if (isObject(result) && "error" in result) {
    await failStepRun({
      client: db, runId: run.id, failureCode: String(result.error), category: categoryOf(result),
      reason: `Step ${run.step_key} reported a failure: ${String(result.error)}`,
      detail: { runner_reported_result: result },
    });
  } else if (!isObject(result)) {
    await failStepRun({ client: db, runId: run.id, failureCode: "step_result_invalid", reason: `Step ${run.step_key} returned an answer that is not a JSON object` });
  } else {
    await succeedStepRun(db, run.id, result);
  }

  try {
    const { data: parent, error: parentError } = await db.from("agent_runs").select("kind").eq("id", run.parent_run_id).maybeSingle();
    if (parentError) throw parentError;
    const kind = (parent as { kind: StepParentKind } | null)?.kind;
    if (kind) await advanceWorkflow({ client: db, config, workflow: resolveWorkflow(kind), launch: options.launch }, run.parent_run_id);
  } catch (advanceError) {
    // The step is recorded. The scheduler's next pass moves the parent on, so the runner need not call again.
    await recordError({ client: db, workspaceId: run.workspace_id, agentRunId: run.parent_run_id, operation: "execution", code: "step_advance_failed", message: "Moving a routine run on after a step run ended failed", error: advanceError }).catch(() => undefined);
  }
  return new Response(null, { status: 204 });
}
