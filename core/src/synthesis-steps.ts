import type { HarnessId } from "./harnesses";

/** The three steps of the nightly synthesis, in order. */
export const SYNTHESIS_STEP_KEYS = ["capture", "reconcile", "organize"] as const;
export type SynthesisStepKey = (typeof SYNTHESIS_STEP_KEYS)[number];

const LIGHT = { claude: "haiku", codex: "gpt-6-luna" } as const satisfies Record<HarnessId, string>;
const JUDGMENT = { claude: "sonnet", codex: "gpt-6.1-terra" } as const satisfies Record<HarnessId, string>;

/**
 * The model each harness uses for a step unless a person picked one. Capture is light work, so it uses the small
 * model; reconcile and organize judge, so they use the larger one. The editor shows these, so they live here.
 */
export const SYNTHESIS_STEP_MODELS: Record<SynthesisStepKey, Record<HarnessId, string>> = {
  capture: LIGHT,
  reconcile: JUDGMENT,
  organize: JUDGMENT,
};
