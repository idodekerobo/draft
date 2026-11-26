import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineStep } from "draft-core/routine-steps";
import type { AgentRunToolset, ComputerPolicy, StepParentKind } from "draft-core/run-spec";
import type { AnyDraftToolPermission } from "draft-core/tools";
import type { SandboxDeploymentConfig } from "../metaharness/sandbox";
import type { launchWithCredentials } from "../metaharness/sandbox/launch-with-credentials";
import type { ValidatedRunBundle } from "../synthesis/context-version-files";
import type { AgentRunRow } from "../types/tables";

/** The run of a routine that has steps. It starts no agent itself. */
export type ParentRun = AgentRunRow & { kind: StepParentKind };

/** What a step run works on. `key` names the item, so a retry of a failed run is known to repeat it. */
export type StepItem =
  | { key: string; type: "none" }
  | { key: string; type: "source_batch"; sourceCount: number }
  | { key: string; type: "document"; path: string }
  | { key: string; type: "new_documents" };

/** A source item a step run reads, as the run's membership rows record it. */
export interface PlannedMembership {
  sourceItemId: string;
  version: string;
  contentHash: string;
}

/** One run a step will start, before it exists. */
export interface PlannedRun {
  item: StepItem;
  /** Source items the run reads. They become the run's own membership rows. */
  membership?: PlannedMembership[];
}

/** What the succeeded runs of each earlier step produced, by step key. A skipped step has an empty list. */
export type StepOutputs = Record<string, Array<{ run: AgentRunRow; result: unknown }>>;

export interface WorkflowContext {
  client: SupabaseClient;
  parent: ParentRun;
}

/**
 * What differs between routines that have steps. The engine starts, retries and advances step runs the same way for
 * all of them; the workflow says what each step works on, what a run is given, and how the routine ends.
 */
export interface WorkflowKind {
  kind: StepParentKind;
  /** The permissions the routine itself has. A step run keeps only the ones of its own list that are in this list. */
  routinePermissions(ctx: WorkflowContext): Promise<ReadonlyArray<AnyDraftToolPermission>>;
  /** The tools, computer and model every run of the routine's steps gets. A step's own model wins when it has one. */
  environment(ctx: WorkflowContext, step: RoutineStep): Promise<{ toolset: AgentRunToolset; computer: ComputerPolicy; model: string | null }>;
  /** The runs of one step. None means the step is skipped. Called once, when the steps before it are done. */
  plan(ctx: WorkflowContext & { step: RoutineStep; outputs: StepOutputs }): Promise<PlannedRun[]>;
  /** The files and prompt one step run is launched with. */
  prepareRun(ctx: WorkflowContext & { step: RoutineStep; run: AgentRunRow; outputs: StepOutputs }): Promise<{ bundle: ValidatedRunBundle; prompt: string }>;
  /** Ends the routine's run after its last step. */
  finish(ctx: WorkflowContext & { steps: RoutineStep[]; outputs: StepOutputs; runs: AgentRunRow[] }): Promise<void>;
  /** Fails the routine's run. False when it had already ended. */
  fail(ctx: WorkflowContext & { code: string; reason: string; detail?: Record<string, unknown> }): Promise<boolean>;
}

export interface EngineDeps {
  client: SupabaseClient;
  config: SandboxDeploymentConfig;
  workflow: WorkflowKind;
  now?: () => Date;
  /** Replaced in tests. */
  launch?: typeof launchWithCredentials;
}

/** How many step runs of one routine run may be active at once. Codex has one login, so it runs one at a time. */
export const STEP_RUN_CONCURRENCY: Record<string, number> = { claude: 4, codex: 1 };

/** Attempts a step run gets: one retry, or two when the provider rate-limited it. */
export const MAX_STEP_ATTEMPTS = 2;
export const MAX_RATE_LIMITED_STEP_ATTEMPTS = 3;
/** Minutes to wait before the retry that follows a rate-limited attempt N. Other failures retry at once. */
export const RATE_LIMIT_BACKOFF_MINUTES = [5, 15];

/** A step run or routine run stuck this long with no change is ended by the sweep. */
export const STALE_STEP_AFTER_MS = 30 * 60_000;
