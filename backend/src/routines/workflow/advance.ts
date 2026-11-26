import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import type { RoutineStep } from "draft-core/routine-steps";
import { createAgentRun, specFromRow } from "../../metaharness/runs/agent-run-store";
import { isActiveRun, launchStepRun } from "./launch-step-run";
import { emitParentRunFinished } from "./parent-finished";
import { buildStepRunSpec, stepsOfParent } from "./step-run-spec";
import { hasAttemptsLeft, retryNotBefore } from "./step-failure";
import { STEP_PARENT_KINDS, STEP_RUN_CONCURRENCY, type EngineDeps, type ParentRun, type PlannedRun, type StepItem, type StepOutputs } from "./types";
import type { AgentRunRow } from "../../types/tables";
import { randomUUID } from "node:crypto";

export type AdvanceState = "inactive" | "waiting" | "finished" | "failed";

const UNIQUE_VIOLATION = "23505";
const MAX_PASSES = 6;

const isFailed = (run: AgentRunRow): boolean => ["failed", "stale", "cancelled"].includes(run.status);
const isUnfinished = (run: AgentRunRow): boolean => run.status === "queued" || isActiveRun(run);

async function loadParent(client: SupabaseClient, parentRunId: string): Promise<ParentRun | null> {
  const { data, error } = await client.from("agent_runs").select("*").eq("id", parentRunId).in("kind", STEP_PARENT_KINDS).maybeSingle();
  if (error) throw error;
  return (data as ParentRun | null) ?? null;
}

async function loadChildren(client: SupabaseClient, parentRunId: string): Promise<AgentRunRow[]> {
  const { data, error } = await client.from("agent_runs").select("*").eq("parent_run_id", parentRunId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AgentRunRow[];
}

/** The attempts of each item of a step, oldest first, by the item's key. */
function attemptsByItem(runs: ReadonlyArray<AgentRunRow>): Map<string, AgentRunRow[]> {
  const byItem = new Map<string, AgentRunRow[]>();
  for (const run of runs) {
    const key = run.step_item?.key ?? run.id;
    byItem.set(key, [...(byItem.get(key) ?? []), run].sort((a, b) => a.attempt - b.attempt));
  }
  return byItem;
}

const latestAttempts = (runs: ReadonlyArray<AgentRunRow>): AgentRunRow[] => [...attemptsByItem(runs).values()].map((attempts) => attempts.at(-1)!);

/** Inserts a run, or returns false when another caller already inserted the same one (same idempotency key). */
async function insertRun(client: SupabaseClient, input: Parameters<typeof createAgentRun>[1]): Promise<boolean> {
  try {
    await createAgentRun(client, input);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false;
    throw error;
  }
}

async function insertMembership(client: SupabaseClient, workspaceId: string, runId: string, rows: ReadonlyArray<{ sourceItemId: string; version: string; contentHash: string }>): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client.from("agent_run_source_items").insert(rows.map((row, position) => ({
    workspace_id: workspaceId, agent_run_id: runId, source_item_id: row.sourceItemId, position, source_item_version: row.version, content_hash: row.contentHash,
  })));
  if (error) throw error;
}

/** Creates the queued runs of a step. A run that already exists is left alone. */
async function createPlannedRuns(deps: EngineDeps, parent: ParentRun, step: RoutineStep, planned: ReadonlyArray<PlannedRun>): Promise<void> {
  const { client, workflow } = deps;
  const ctx = { client, parent };
  const [routinePermissions, environment] = await Promise.all([workflow.routinePermissions(ctx), workflow.environment(ctx, step)]);
  for (const run of planned) {
    const runId = randomUUID();
    const spec = buildStepRunSpec({ runId, parent, step, environment, routinePermissions, contextVersionId: parent.base_context_version_id });
    const created = await insertRun(client, {
      spec,
      idempotencyKey: `${parent.id}:${step.key}:${run.item.key}:1`,
      status: "queued",
      attempt: 1,
      promptVersion: parent.prompt_version ?? undefined,
      scheduledTaskId: parent.scheduled_task_id ?? undefined,
      parentRunId: parent.id,
      stepKey: step.key,
      stepItem: run.item,
    });
    if (created) await insertMembership(client, parent.workspace_id, runId, run.membership ?? []);
  }
}

/** Queues the next attempt of a failed run: the same item, with the same sources. */
async function createRetryRun(deps: EngineDeps, parent: ParentRun, step: RoutineStep, failed: AgentRunRow): Promise<void> {
  const { client } = deps;
  const runId = randomUUID();
  const created = await insertRun(client, {
    spec: { ...specFromRow(failed), id: runId as never },
    idempotencyKey: `${parent.id}:${step.key}:${failed.step_item?.key ?? failed.id}:${failed.attempt + 1}`,
    status: "queued",
    attempt: failed.attempt + 1,
    promptVersion: parent.prompt_version ?? undefined,
    scheduledTaskId: parent.scheduled_task_id ?? undefined,
    parentRunId: parent.id,
    stepKey: step.key,
    stepItem: failed.step_item ?? undefined,
    retryOfRunId: failed.id,
  });
  if (!created) return;
  const { data, error } = await client.from("agent_run_source_items").select("source_item_id, source_item_version, content_hash, position").eq("agent_run_id", failed.id).order("position", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ source_item_id: string; source_item_version: string; content_hash: string }>;
  await insertMembership(client, parent.workspace_id, runId, rows.map((row) => ({ sourceItemId: row.source_item_id, version: row.source_item_version, contentHash: row.content_hash })));
}

/** Starts queued runs of a step, up to the harness's limit. A retry after a rate limit waits out its backoff. */
async function launchEligible(deps: EngineDeps, parent: ParentRun, step: RoutineStep, runs: ReadonlyArray<AgentRunRow>, outputs: StepOutputs): Promise<{ failedLaunch: boolean }> {
  const capacity = (STEP_RUN_CONCURRENCY[parent.harness] ?? 1) - runs.filter(isActiveRun).length;
  if (capacity <= 0) return { failedLaunch: false };
  const now = (deps.now ?? (() => new Date()))();
  const byId = new Map(runs.map((run) => [run.id, run]));
  const eligible = runs
    .filter((run) => run.status === "queued")
    .filter((run) => {
      const previous = run.retry_of_run_id ? byId.get(run.retry_of_run_id) : undefined;
      return !previous || now.getTime() >= retryNotBefore(previous).getTime();
    });
  let failedLaunch = false;
  for (const run of eligible.slice(0, capacity)) {
    const outcome = await launchStepRun(deps, parent, step, run, outputs);
    if (outcome === "lease_busy") break;
    if (outcome === "failed") failedLaunch = true;
  }
  return { failedLaunch };
}

/** Stops the queued runs of a parent that has ended, so nothing starts after it. Runs already going finish on their own. */
async function cancelQueuedRuns(client: SupabaseClient, parentRunId: string): Promise<void> {
  await client.from("agent_runs").update({ status: "cancelled", completed_at: new Date().toISOString() }).eq("parent_run_id", parentRunId).eq("status", "queued");
}

async function failParent(deps: EngineDeps, parent: ParentRun, code: string, reason: string, detail?: Record<string, unknown>): Promise<void> {
  const failed = await deps.workflow.fail({ client: deps.client, parent, code, reason, detail });
  await cancelQueuedRuns(deps.client, parent.id);
  if (failed) await emitParentRunFinished(deps.client, parent.id);
}

async function advanceOnce(deps: EngineDeps, parentRunId: string): Promise<{ state: AdvanceState; again?: boolean }> {
  const { client, workflow } = deps;
  const parent = await loadParent(client, parentRunId);
  if (!parent || !(ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(parent.status)) return { state: "inactive" };
  if (parent.kind !== workflow.kind) throw new Error(`Run ${parent.id} is a ${parent.kind} run, not a ${workflow.kind} run`);

  const steps = stepsOfParent(parent);
  if (!steps) {
    await failParent(deps, parent, "workflow_steps_missing", "The run has no saved steps to carry out");
    return { state: "failed" };
  }

  let runs = await loadChildren(client, parent.id);
  const outputs: StepOutputs = {};
  for (const step of steps) {
    let mine = runs.filter((run) => run.step_key === step.key);
    if (mine.length === 0) {
      const planned = await workflow.plan({ client, parent, step, outputs });
      if (planned.length === 0) {
        outputs[step.key] = [];
        continue;
      }
      await createPlannedRuns(deps, parent, step, planned);
      runs = await loadChildren(client, parent.id);
      mine = runs.filter((run) => run.step_key === step.key);
    }

    // A failed item with attempts left gets a new run.
    let queuedRetry = false;
    for (const failed of latestAttempts(mine).filter(isFailed)) {
      if (hasAttemptsLeft(failed)) {
        await createRetryRun(deps, parent, step, failed);
        queuedRetry = true;
      }
    }
    if (queuedRetry) {
      runs = await loadChildren(client, parent.id);
      mine = runs.filter((run) => run.step_key === step.key);
    }

    const latest = latestAttempts(mine);
    // An item out of attempts has failed the step. Stop now rather than spend on items whose answers cannot be used.
    const outOfAttempts = latest.filter((run) => isFailed(run) && !hasAttemptsLeft(run));
    if (outOfAttempts.length > 0 && !step.allowPartial) {
      const codes = [...new Set(outOfAttempts.map((run) => run.failure_code ?? "unknown"))].join(", ");
      await failParent(deps, parent, "step_failed", `Step ${step.key} failed: ${outOfAttempts.length} of ${latest.length} runs did not finish (${codes})`, {
        step_key: step.key, failed_run_ids: outOfAttempts.map((run) => run.id),
      });
      return { state: "failed" };
    }
    if (latest.some(isUnfinished)) {
      const { failedLaunch } = await launchEligible(deps, parent, step, mine, outputs);
      return { state: "waiting", again: failedLaunch };
    }

    const failed = latest.filter((run) => run.status !== "succeeded");
    const succeeded = latest.filter((run) => run.status === "succeeded");
    if (failed.length > 0 && !(step.allowPartial && succeeded.length > 0)) {
      const codes = [...new Set(failed.map((run) => run.failure_code ?? "unknown"))].join(", ");
      await failParent(deps, parent, "step_failed", `Step ${step.key} failed: ${failed.length} of ${latest.length} runs did not finish (${codes})`, {
        step_key: step.key, failed_run_ids: failed.map((run) => run.id),
      });
      return { state: "failed" };
    }
    outputs[step.key] = succeeded.map((run) => ({ run, result: run.result_json }));
  }

  try {
    await workflow.finish({ client, parent, steps, outputs, runs });
  } catch (finishError) {
    // Another caller finished the run first. Anything else is a real failure.
    const after = await loadParent(client, parent.id);
    if (after && !(ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(after.status)) return { state: "finished" };
    throw finishError;
  }
  await emitParentRunFinished(client, parent.id);
  return { state: "finished" };
}

/**
 * Makes whatever progress the run of a routine with steps can make now: plans the next step, retries failed runs,
 * starts queued runs, or finishes the run. Safe to call at any time and from several places at once: a run is
 * planned once (its idempotency key is unique), started once (a guarded update claims it) and finished once.
 */
export async function advanceWorkflow(deps: EngineDeps, parentRunId: string): Promise<AdvanceState> {
  let state: AdvanceState = "waiting";
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = await advanceOnce(deps, parentRunId);
    state = result.state;
    if (!result.again) return state;
  }
  return state;
}

export type { StepItem };
