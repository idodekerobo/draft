import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineStep } from "draft-core/routine-steps";
import { cloudToolsetFor } from "draft-core/harnesses";
import { SANDBOX_RUN_DIRECTORY, sandboxComputer } from "draft-core/run-spec";
import { SYNTHESIS_PERMISSIONS } from "draft-core/tools";
import type { SandboxDeploymentConfig } from "../../metaharness/sandbox";
import type { EngineDeps, PlannedRun, WorkflowContext, WorkflowKind } from "../../routine-steps/types";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

export const WS = "11111111-1111-4111-8111-111111111111";
export const PARENT = "22222222-2222-4222-8222-222222222222";
export const VERSION_1 = "44444444-4444-4444-8444-444444444441";
export const VERSION_2 = "44444444-4444-4444-8444-444444444442";
export const SECRET = "step-callback-secret";
export const CONFIG = { callbackSecret: SECRET } as unknown as SandboxDeploymentConfig;

export const step = (key: string, overrides: Partial<RoutineStep> = {}): RoutineStep => ({
  key, prompt: `Do ${key}.`, model: null, permissions: [{ tool: "context.read" }], fanOut: { over: "none" },
  output: { type: "structured", schema: { type: "object" } }, ...overrides,
});

export const items = (count: number, prefix = "item"): PlannedRun[] =>
  Array.from({ length: count }, (_, index) => ({ item: { key: `${prefix}-${index + 1}`, type: "none" as const } }));

export interface Harness {
  db: FakeDb;
  client: SupabaseClient;
  deps: EngineDeps;
  workflow: WorkflowKind;
  /** Spec ids of runs the engine started, in order. */
  launched: string[];
  /** Base context version of each launched run, by run id. */
  launchedFrom: Map<string, string>;
  finished: Array<{ outputs: Record<string, unknown[]>; runs: number }>;
  failed: Array<{ code: string; reason: string }>;
  /** Make the next launch fail with this error. */
  failNextLaunch(error: Error): void;
  setNow(date: Date): void;
}

export interface SetupOptions {
  harness?: "claude" | "codex";
  steps: RoutineStep[];
  plans?: Record<string, (ctx: WorkflowContext & { outputs: Record<string, Array<{ result: unknown }>> }) => PlannedRun[]>;
  parent?: Record<string, unknown>;
  extraTables?: Record<string, Array<Record<string, unknown>>>;
}

let tick = 0;

/** A fake database with one running synthesis parent that has the given steps, and a workflow that records what happens. */
export function setup(options: SetupOptions): Harness {
  const harness = options.harness ?? "claude";
  const db = fakeDb(
    {
      workspaces: [{ id: WS, current_context_version_id: VERSION_1 }],
      agent_runs: [{
        id: PARENT, workspace_id: WS, kind: "synthesis", status: "running", harness, attempt: 1, on_behalf_of_user_id: null, scheduled_task_id: null,
        session_id: null, reasoning_effort: null, base_context_version_id: VERSION_1, prompt_version: "synthesis-v3", outcome: null,
        created_at: "2026-11-26T00:00:00.000Z", updated_at: "2026-11-26T00:00:00.000Z", result_json: { steps: options.steps }, ...options.parent,
      }],
      agent_run_source_items: [],
      errors: [],
      credentials: [],
      ...options.extraTables,
    },
    { unique: { agent_runs: [{ name: "agent_runs_workspace_id_idempotency_key_key", columns: ["workspace_id", "idempotency_key"] }] }, uuidTables: ["agent_runs"] },
  );
  const base = fakeClient(db);
  // The real table stamps these. The fake does not, and the engine orders its queue by created_at.
  const client = {
    ...base,
    from: (table: string) => {
      const query = base.from(table) as unknown as { insert: (row: unknown) => unknown };
      if (table === "agent_runs") {
        const insert = query.insert.bind(query);
        query.insert = (row: unknown) => insert({ created_at: new Date(Date.UTC(2026, 10, 26, 0, 0, 0) + ++tick * 1000).toISOString(), updated_at: "2026-11-26T00:00:01.000Z", ...(row as object) });
      }
      return query;
    },
  } as unknown as SupabaseClient;

  const state: Pick<Harness, "launched" | "launchedFrom" | "finished" | "failed"> = { launched: [], launchedFrom: new Map(), finished: [], failed: [] };
  let nextLaunchError: Error | null = null;
  // The real clock unless a test sets one, so what the engine stamps and what it compares agree.
  let fixedNow: Date | null = null;

  const workflow: WorkflowKind = {
    kind: "synthesis",
    routinePermissions: async () => SYNTHESIS_PERMISSIONS,
    environment: async () => ({ toolset: cloudToolsetFor(harness), computer: sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY), model: null }),
    plan: async (ctx) => (options.plans?.[ctx.step.key] ? options.plans[ctx.step.key]!({ ...ctx, outputs: ctx.outputs }) : items(1, ctx.step.key)),
    prepareRun: async ({ run }) => ({ bundle: { organizationId: "org", workspaceId: WS, runId: run.id, bundleHash: "h".repeat(64), files: {} } as never, prompt: `prompt for ${run.step_key}` }),
    // Like finalize_synthesis_run: the run must still be running, so a second finish raises.
    finish: async ({ outputs, runs }) => {
      const { data } = await client.from("agent_runs").update({ status: "succeeded", outcome: "no_change", completed_at: new Date().toISOString() }).eq("id", PARENT).in("status", ["running"]).select("id");
      if (!(data as unknown[] | null)?.length) throw new Error("finalize_synthesis_run: run is not running");
      state.finished.push({ outputs: Object.fromEntries(Object.entries(outputs).map(([key, list]) => [key, list.map((entry) => entry.result)])), runs: runs.length });
    },
    fail: async ({ code, reason }) => {
      const { data } = await client.from("agent_runs").update({ status: "failed", outcome: "failure", failure_code: code, summary: reason }).eq("id", PARENT).in("status", ["running", "preparing"]).select("id");
      if ((data as unknown[] | null)?.length) state.failed.push({ code, reason });
      return (data as unknown[] | null)?.length === 1;
    },
  };

  const deps: EngineDeps = {
    client, config: CONFIG, workflow, now: () => fixedNow ?? new Date(),
    launch: (async ({ spec }: { spec: { id: string } }) => {
      if (nextLaunchError) { const error = nextLaunchError; nextLaunchError = null; throw error; }
      state.launched.push(spec.id);
      const run = (db.tables.agent_runs ?? []).find((row) => row.id === spec.id);
      state.launchedFrom.set(spec.id, String(run?.base_context_version_id));
      return { machineId: `machine-${spec.id.slice(0, 4)}`, state: "started", runId: spec.id, bundleHash: "h".repeat(64), callbackExpiresAt: 0 };
    }) as never,
  };

  return { db, client, deps, workflow, ...state, failNextLaunch: (error) => { nextLaunchError = error; }, setNow: (date) => { fixedNow = date; } };
}

export const children = (harness: Harness, stepKey?: string) =>
  (harness.db.tables.agent_runs ?? []).filter((row) => row.parent_run_id === PARENT && (stepKey === undefined || row.step_key === stepKey));

export const parentRow = (harness: Harness) => (harness.db.tables.agent_runs ?? []).find((row) => row.id === PARENT)!;

/** Ends a run the way its callback would. */
export function endRun(harness: Harness, runId: string, outcome: { status: "succeeded"; result?: unknown } | { status: "failed"; code?: string; category?: string | null }): void {
  const row = (harness.db.tables.agent_runs ?? []).find((entry) => entry.id === runId)!;
  Object.assign(row, outcome.status === "succeeded"
    ? { status: "succeeded", result_json: outcome.result ?? {}, completed_at: harness.deps.now!().toISOString() }
    : { status: "failed", failure_code: outcome.code ?? "claude_error", failure_detail: outcome.category ?? null, completed_at: harness.deps.now!().toISOString() });
}
