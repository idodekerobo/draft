import { z } from "zod";
import { getHarness, isKnownModel, type HarnessId } from "./harnesses";
import type { JsonSchema } from "./run-spec";
import { DRAFT_TOOLS, type AnyDraftToolPermission } from "./tools";

/** What a step fans out over: one run, or one run for each item. */
export type StepFanOut =
  | { over: "none" }
  | { over: "source_batches"; maxTokensPerBatch: number }
  | { over: "context_documents"; filter: "with_new_evidence" | "all_stable" };

export type StepOutput = { type: "text" } | { type: "structured"; schema: JsonSchema };

/** One stage in a routine's ordered step list. A step starts one or more step runs. */
export interface RoutineStep {
  /** "capture", "reconcile", "organize", or a custom key. Unique in the list. */
  key: string;
  prompt: string;
  /** A model alias of the routine's harness. Null means the default for this step. */
  model: string | null;
  /**
   * Must be a subset of the routine's permissions, never wider. Left out, the step may use everything the routine may,
   * and no more.
   */
  permissions?: AnyDraftToolPermission[];
  fanOut: StepFanOut;
  output: StepOutput;
  /** Keys of earlier steps whose outputs this step reads. */
  inputsFrom?: string[];
  /**
   * When true, the step passes if at least one of its runs succeeded, and the items of the runs that failed stay
   * undone. Left out, any run that fails after its retries fails the routine's run.
   */
  allowPartial?: boolean;
}

export const MAX_ROUTINE_STEPS = 10;
export const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const STEP_PROMPT_MAX_CHARS = 20_000;
const STEP_SCHEMA_MAX_CHARS = 20_000;

const toolNames = DRAFT_TOOLS.map((tool) => tool.name) as [string, ...string[]];

const permissionSchema = z.object({
  tool: z.enum(toolNames),
  provider: z.string().min(1).max(40).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
}).strict();

const fanOutSchema = z.discriminatedUnion("over", [
  z.object({ over: z.literal("none") }).strict(),
  z.object({ over: z.literal("source_batches"), maxTokensPerBatch: z.number().int().min(1_000).max(500_000) }).strict(),
  z.object({ over: z.literal("context_documents"), filter: z.enum(["with_new_evidence", "all_stable"]) }).strict(),
]);

const outputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("structured"), schema: z.record(z.string(), z.unknown()) }).strict(),
]);

/** The shape of a step as it is stored and sent in a request. Whether it fits its routine is checked by `checkRoutineSteps`. */
export const RoutineStepInput = z.object({
  key: z.string().regex(STEP_KEY_PATTERN),
  prompt: z.string().trim().min(1).max(STEP_PROMPT_MAX_CHARS),
  model: z.string().min(1).max(80).nullable(),
  permissions: z.array(permissionSchema).max(40).optional(),
  fanOut: fanOutSchema,
  output: outputSchema,
  inputsFrom: z.array(z.string().regex(STEP_KEY_PATTERN)).max(MAX_ROUTINE_STEPS).optional(),
  allowPartial: z.boolean().optional(),
}).strict();

export const RoutineStepsInput = z.array(RoutineStepInput).min(1).max(MAX_ROUTINE_STEPS);

/** The step list of a routine that has none: one step built from the routine's own prompt, model and permissions. */
export function stepsOf(routine: {
  steps?: ReadonlyArray<RoutineStep>;
  prompt: string;
  model: string | null;
  permissions: ReadonlyArray<AnyDraftToolPermission>;
}): RoutineStep[] {
  if (routine.steps && routine.steps.length > 0) return [...routine.steps];
  return [{ key: "main", prompt: routine.prompt, model: routine.model, permissions: [...routine.permissions], fanOut: { over: "none" }, output: { type: "text" } }];
}

/** A routine has steps when its list has any. A routine without them runs as one agent, as before. */
export const hasSteps = (routine: { steps?: ReadonlyArray<RoutineStep> }): boolean => (routine.steps?.length ?? 0) > 0;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameGrant = (a: AnyDraftToolPermission, b: AnyDraftToolPermission): boolean =>
  a.tool === b.tool && (a.provider ?? null) === (b.provider ?? null) && stableJson(a.limits) === stableJson(b.limits);

/** The permissions of a step that its routine does not have. A step may only narrow: same tool, provider and limits. */
export function permissionsBeyondRoutine(step: Pick<RoutineStep, "permissions">, routine: ReadonlyArray<AnyDraftToolPermission>): AnyDraftToolPermission[] {
  return (step.permissions ?? []).filter((permission) => !routine.some((granted) => sameGrant(permission, granted)));
}

/** What a step may use when it runs: its own permissions, kept only where the routine still grants them. */
export function resolveStepPermissions(step: Pick<RoutineStep, "permissions">, routine: ReadonlyArray<AnyDraftToolPermission>): AnyDraftToolPermission[] {
  if (!step.permissions) return [...routine];
  return step.permissions.filter((permission) => routine.some((granted) => sameGrant(permission, granted)));
}

export type StepsProblem =
  | { code: "invalid_shape" }
  | { code: "duplicate_key"; key: string }
  | { code: "bad_model"; key: string }
  | { code: "bad_input"; key: string }
  | { code: "too_large"; key: string }
  | { code: "fan_out_not_allowed"; key: string }
  | { code: "permission_beyond_routine"; key: string; tool: string };

export type StepsCheck = { ok: true; steps: RoutineStep[] } | { ok: false; problem: StepsProblem };

/** Which fan-outs a routine's steps may use. A custom routine has no source batches; only synthesis consumes sources. */
export type StepsContext = {
  harness: HarnessId;
  /** The routine's own permissions. Steps are checked against them. Null skips that check. */
  routinePermissions: ReadonlyArray<AnyDraftToolPermission> | null;
  allowSourceBatches: boolean;
};

/** Checks a step list against its routine: shape, unique keys, models, inputs, fan-out and permissions. */
export function checkRoutineSteps(value: unknown, context: StepsContext): StepsCheck {
  const parsed = RoutineStepsInput.safeParse(value);
  if (!parsed.success) return { ok: false, problem: { code: "invalid_shape" } };
  const steps = parsed.data as RoutineStep[];
  const definition = getHarness(context.harness);
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.key)) return { ok: false, problem: { code: "duplicate_key", key: step.key } };
    if (step.model !== null && (!definition || !isKnownModel(context.harness, step.model))) return { ok: false, problem: { code: "bad_model", key: step.key } };
    if (step.inputsFrom?.some((key) => !seen.has(key))) return { ok: false, problem: { code: "bad_input", key: step.key } };
    if (step.fanOut.over === "source_batches" && !context.allowSourceBatches) return { ok: false, problem: { code: "fan_out_not_allowed", key: step.key } };
    if (step.output.type === "structured" && JSON.stringify(step.output.schema).length > STEP_SCHEMA_MAX_CHARS) return { ok: false, problem: { code: "too_large", key: step.key } };
    if (context.routinePermissions) {
      const beyond = permissionsBeyondRoutine(step, context.routinePermissions)[0];
      if (beyond) return { ok: false, problem: { code: "permission_beyond_routine", key: step.key, tool: beyond.tool } };
    }
    seen.add(step.key);
  }
  return { ok: true, steps };
}

