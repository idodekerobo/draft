import type { HarnessId } from "./harnesses";
import type { JsonSchema } from "./run-spec";
import type { RoutineStep, StepFanOut, StepOutput } from "./routine-steps";
import { CAPTURE_PERMISSIONS, ORGANIZE_PERMISSIONS, RECONCILE_PERMISSIONS, type AnyDraftToolPermission } from "./tools";

/** The three steps of the nightly synthesis, in order. */
export const SYNTHESIS_STEP_KEYS = ["capture", "reconcile", "organize"] as const;
export type SynthesisStepKey = (typeof SYNTHESIS_STEP_KEYS)[number];

/** Saved as the prompt version of every synthesis run that has steps. */
export const SYNTHESIS_PROMPT_VERSION = "synthesis-v3";

/** The most source text one capture run reads, in tokens (about four characters each). A cost lever, not a limit. */
export const CAPTURE_MAX_TOKENS_PER_BATCH = 50_000;

const PERIODS = ["day", "week", "month"] as const;

const evidenceSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["source_item_id", "excerpt"],
    properties: { source_item_id: { type: "string" }, excerpt: { type: "string" } },
  },
} as const;

/** One memory entry a capture run returns. A later step writes it into memory; capture writes nothing. */
export interface CaptureEntry {
  period: (typeof PERIODS)[number];
  text: string;
  source_item_ids: string[];
  /** Paths of stable documents the entry bears on. A path with no document yet asks for a new one. */
  affects: string[];
}

export interface CaptureResult {
  summary: string;
  entries: CaptureEntry[];
}

export interface ReconcileConflict {
  path: string;
  claim: string;
  new_claim: string;
  reason: string;
  evidence: Array<{ source_item_id: string; excerpt: string }>;
}

export interface ReconcileResult {
  summary: string;
  changed: boolean;
  /** Claims the sources cannot settle. Organize records them. */
  conflicts: ReconcileConflict[];
}

export const CAPTURE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "entries"],
  properties: {
    summary: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["period", "text", "source_item_ids", "affects"],
        properties: {
          period: { type: "string", enum: [...PERIODS] },
          text: { type: "string" },
          source_item_ids: { type: "array", items: { type: "string" } },
          affects: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const RECONCILE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changed", "conflicts"],
  properties: {
    summary: { type: "string" },
    changed: { type: "boolean" },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "claim", "new_claim", "reason", "evidence"],
        properties: {
          path: { type: "string" },
          claim: { type: "string" },
          new_claim: { type: "string" },
          reason: { type: "string" },
          evidence: evidenceSchema,
        },
      },
    },
  },
};

/** What organize reports, and so what the synthesis run reports: the same answer a single-pass run gave. */
export const ORGANIZE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "needs_input"],
  properties: {
    outcome: { type: "string", enum: ["changed", "no_change"] },
    summary: { type: "string", minLength: 1 },
    needs_input: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "current_claim", "new_claim", "reason", "evidence"],
        properties: {
          question: { type: "string" },
          current_claim: { type: "string" },
          new_claim: { type: "string" },
          reason: { type: "string" },
          evidence: evidenceSchema,
        },
      },
    },
  },
};

/** A synthesis step without its prompt. The backend adds the prompt text. */
export interface SynthesisStepDefinition {
  key: SynthesisStepKey;
  fanOut: StepFanOut;
  permissions: ReadonlyArray<AnyDraftToolPermission>;
  output: StepOutput;
  inputsFrom?: SynthesisStepKey[];
  allowPartial?: boolean;
  /**
   * The model each harness uses for this step unless a person picked one. Capture is light work, so it uses the
   * small model; reconcile and organize judge, so they use the larger one.
   */
  models: Record<HarnessId, string>;
}

const LIGHT = { claude: "haiku", codex: "gpt-6-luna" } as const satisfies Record<HarnessId, string>;
const JUDGMENT = { claude: "sonnet", codex: "gpt-6.1-terra" } as const satisfies Record<HarnessId, string>;

export const SYNTHESIS_STEP_DEFINITIONS: ReadonlyArray<SynthesisStepDefinition> = [
  {
    key: "capture",
    fanOut: { over: "source_batches", maxTokensPerBatch: CAPTURE_MAX_TOKENS_PER_BATCH },
    permissions: CAPTURE_PERMISSIONS,
    output: { type: "structured", schema: CAPTURE_OUTPUT_SCHEMA },
    // A batch that fails twice leaves its sources for the next run. The others still count.
    allowPartial: true,
    models: LIGHT,
  },
  {
    key: "reconcile",
    fanOut: { over: "context_documents", filter: "with_new_evidence" },
    permissions: RECONCILE_PERMISSIONS,
    output: { type: "structured", schema: RECONCILE_OUTPUT_SCHEMA },
    inputsFrom: ["capture"],
    models: JUDGMENT,
  },
  {
    key: "organize",
    fanOut: { over: "none" },
    permissions: ORGANIZE_PERMISSIONS,
    output: { type: "structured", schema: ORGANIZE_OUTPUT_SCHEMA },
    inputsFrom: ["capture", "reconcile"],
    models: JUDGMENT,
  },
];

/** The step list of a synthesis run, with each step's prompt. `model` overrides every step's default when set. */
export function synthesisSteps(input: { harness: HarnessId; prompts: Record<SynthesisStepKey, string>; model?: string | null }): RoutineStep[] {
  return SYNTHESIS_STEP_DEFINITIONS.map((definition) => ({
    key: definition.key,
    prompt: input.prompts[definition.key],
    model: input.model ?? definition.models[input.harness],
    permissions: [...definition.permissions],
    fanOut: definition.fanOut,
    output: definition.output,
    ...(definition.inputsFrom ? { inputsFrom: [...definition.inputsFrom] } : {}),
    ...(definition.allowPartial ? { allowPartial: true } : {}),
  }));
}
