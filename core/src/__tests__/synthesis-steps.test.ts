import { describe, expect, it } from "bun:test";
import { isKnownModel } from "../harnesses";
import { SYNTHESIS_STEP_KEYS, SYNTHESIS_STEP_MODELS } from "../synthesis-steps";

describe("the synthesis step models", () => {
  it("names a model for every step on every harness, and each one exists", () => {
    for (const key of SYNTHESIS_STEP_KEYS) {
      for (const harness of ["claude", "codex"] as const) expect(isKnownModel(harness, SYNTHESIS_STEP_MODELS[key][harness])).toBe(true);
    }
  });

  it("uses the small model for capture and the larger one for the judgment steps", () => {
    expect(SYNTHESIS_STEP_KEYS.map((key) => SYNTHESIS_STEP_MODELS[key].claude)).toEqual(["haiku", "sonnet", "sonnet"]);
    expect(SYNTHESIS_STEP_KEYS.map((key) => SYNTHESIS_STEP_MODELS[key].codex)).toEqual(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-terra"]);
  });
});
