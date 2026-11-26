import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES, type StepParentKind } from "draft-core/run-spec";
import { recordError } from "../errors/record-error";
import type { SandboxDeploymentConfig } from "../metaharness/sandbox";
import { advanceWorkflow } from "./advance";
import { emitParentRunFinished } from "./parent-finished";
import { workflowFor } from "./registry";
import { failStepRun } from "./step-failure";
import { STALE_STEP_AFTER_MS, type EngineDeps, type ParentRun, type WorkflowKind } from "./types";

type Resolve = (kind: StepParentKind) => WorkflowKind;
const ACTIVE_NOT_QUEUED = ACTIVE_AGENT_RUN_STATUSES.filter((status) => status !== "queued");
const PARENT_KINDS = ["synthesis", "routine"];

export interface SweepOptions {
  now?: Date;
  olderThanMs?: number;
  workspaceId?: string;
  resolveWorkflow?: Resolve;
  /** Replaced in tests. */
  launch?: EngineDeps["launch"];
}

/** A parent run that has steps carries them in `result_json`, so a run without it is a plain run. */
async function activeParents(client: SupabaseClient, workspaceId?: string): Promise<ParentRun[]> {
  let query = client.from("agent_runs").select("*").in("kind", PARENT_KINDS).in("status", ACTIVE_AGENT_RUN_STATUSES).not("result_json", "is", null);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ParentRun[];
}

/**
 * Ends step runs that have been active too long with no callback, then lets the engine retry them or fail the
 * parent. The age is of the run's last change, so a run that waited in the queue is not swept for waiting.
 */
export async function sweepStaleStepRuns(client: SupabaseClient, config: SandboxDeploymentConfig, options: SweepOptions = {}): Promise<string[]> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - (options.olderThanMs ?? STALE_STEP_AFTER_MS)).toISOString();
  let query = client.from("agent_runs").select("id, parent_run_id, step_key, status, workspace_id").eq("kind", "step").in("status", ACTIVE_NOT_QUEUED).lt("updated_at", cutoff);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  const { data, error } = await query;
  if (error) throw error;
  const stale = (data ?? []) as Array<{ id: string; parent_run_id: string; step_key: string | null; status: string }>;
  const parentIds = new Set<string>();
  for (const run of stale) {
    const failed = await failStepRun({
      client, runId: run.id, failureCode: "step_run_stale",
      reason: `Step ${run.step_key} was still ${run.status} past the staleness cutoff with no callback from the sandbox.`,
      detail: { swept_from_status: run.status, cutoff },
    });
    if (failed) parentIds.add(run.parent_run_id);
  }
  await advanceParents(client, config, [...parentIds], options.resolveWorkflow ?? workflowFor, options.launch);
  return stale.map((run) => run.id);
}

async function advanceParents(client: SupabaseClient, config: SandboxDeploymentConfig, parentIds: string[], resolve: Resolve, launch?: EngineDeps["launch"]): Promise<void> {
  for (const parentId of parentIds) {
    const { data } = await client.from("agent_runs").select("kind").eq("id", parentId).maybeSingle();
    const kind = (data as { kind: StepParentKind } | null)?.kind;
    if (!kind) continue;
    await advanceWorkflow({ client, config, workflow: resolve(kind), launch }, parentId).catch((error) =>
      recordError({ client, workspaceId: null, agentRunId: parentId, operation: "scheduling", code: "workflow_advance_failed", message: "Moving a routine run on failed", error }),
    );
  }
}

/** Gives every routine run that has steps one pass of the engine. Starts queued runs a busy login held back, and finishes a run whose last callback never moved it on. */
export async function advanceStuckWorkflows(client: SupabaseClient, config: SandboxDeploymentConfig, options: SweepOptions = {}): Promise<number> {
  const parents = await activeParents(client, options.workspaceId);
  await advanceParents(client, config, parents.map((parent) => parent.id), options.resolveWorkflow ?? workflowFor, options.launch);
  return parents.length;
}

/** True when a step run of the parent is queued or going. */
async function hasUnfinishedChild(client: SupabaseClient, parentRunId: string): Promise<boolean> {
  const { data, error } = await client.from("agent_runs").select("status").eq("parent_run_id", parentRunId);
  if (error) throw error;
  return ((data ?? []) as Array<{ status: string }>).some((child) => (ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(child.status));
}

/**
 * Fails a routine run that has steps when nothing is left to start or wait for, and the run still has not ended.
 * A run with a step queued or going is not stuck. A run waiting out a rate-limit backoff has a queued step.
 */
export async function failStrandedParents(client: SupabaseClient, config: SandboxDeploymentConfig, options: SweepOptions = {}): Promise<string[]> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - (options.olderThanMs ?? STALE_STEP_AFTER_MS)).toISOString();
  const resolve = options.resolveWorkflow ?? workflowFor;
  const failed: string[] = [];
  for (const parent of await activeParents(client, options.workspaceId)) {
    if (parent.updated_at >= cutoff) continue;
    if (await hasUnfinishedChild(client, parent.id)) continue;
    // Give the engine one more pass: it may finish the run, or queue and start something.
    const state = await advanceWorkflow({ client, config, workflow: resolve(parent.kind), launch: options.launch }, parent.id);
    if (state === "finished" || state === "failed" || state === "inactive") continue;
    if (await hasUnfinishedChild(client, parent.id)) continue;
    const ended = await resolve(parent.kind).fail({ client, parent, code: "workflow_stalled", reason: "The run has steps left but nothing is running and nothing can start." });
    if (ended) {
      await emitParentRunFinished(client, parent.id);
      failed.push(parent.id);
    }
  }
  return failed;
}
