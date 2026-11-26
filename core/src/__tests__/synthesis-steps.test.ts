import { describe, expect, it } from "bun:test";
import { checkRoutineSteps } from "../routine-steps";
import { CAPTURE_OUTPUT_SCHEMA, ORGANIZE_OUTPUT_SCHEMA, RECONCILE_OUTPUT_SCHEMA, SYNTHESIS_STEP_KEYS, synthesisSteps } from "../synthesis-steps";
import { SYNTHESIS_PERMISSIONS } from "../tools";
import { isKnownModel } from "../harnesses";

const prompts = { capture: "c", reconcile: "r", organize: "o" };

describe("synthesisSteps", () => {
  it("is capture, reconcile, organize, in that order, and a valid step list for synthesis", () => {
    for (const harness of ["claude", "codex"] as const) {
      const steps = synthesisSteps({ harness, prompts });
      expect(steps.map((step) => step.key)).toEqual([...SYNTHESIS_STEP_KEYS]);
      expect(checkRoutineSteps(steps, { harness, routinePermissions: SYNTHESIS_PERMISSIONS, allowSourceBatches: true })).toEqual({ ok: true, steps });
    }
  });

  it("uses the small model for capture and the larger one for the judgment steps, per harness", () => {
    expect(synthesisSteps({ harness: "claude", prompts }).map((step) => step.model)).toEqual(["haiku", "sonnet", "sonnet"]);
    expect(synthesisSteps({ harness: "codex", prompts }).map((step) => step.model)).toEqual(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-terra"]);
    for (const step of synthesisSteps({ harness: "codex", prompts })) expect(isKnownModel("codex", step.model!)).toBe(true);
    for (const step of synthesisSteps({ harness: "claude", prompts })) expect(isKnownModel("claude", step.model!)).toBe(true);
  });

  it("lets a chosen model replace every default", () => {
    expect(synthesisSteps({ harness: "claude", prompts, model: "opus" }).map((step) => step.model)).toEqual(["opus", "opus", "opus"]);
  });

  it("lets capture pass on partial success and no other step", () => {
    expect(synthesisSteps({ harness: "claude", prompts }).map((step) => step.allowPartial === true)).toEqual([true, false, false]);
  });

  it("fans out over source batches, then documents with new evidence, then nothing", () => {
    expect(synthesisSteps({ harness: "claude", prompts }).map((step) => step.fanOut.over)).toEqual(["source_batches", "context_documents", "none"]);
  });

  it("gives each step the prompt for its key, and reads outputs from earlier steps only", () => {
    const steps = synthesisSteps({ harness: "claude", prompts });
    expect(steps.map((step) => step.prompt)).toEqual(["c", "r", "o"]);
    expect(steps.map((step) => step.inputsFrom ?? [])).toEqual([[], ["capture"], ["capture", "reconcile"]]);
  });
});

describe("the output schemas", () => {
  const strict = (schema: unknown): void => {
    const node = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown; additionalProperties?: unknown };
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      // Both harnesses make the model fill every property, so each must be listed as required.
      expect([...(node.required ?? [])].sort()).toEqual(Object.keys(node.properties ?? {}).sort());
      for (const child of Object.values(node.properties ?? {})) strict(child);
    }
    if (node.type === "array") strict(node.items);
  };

  it("are strict objects with every property required", () => {
    for (const schema of [CAPTURE_OUTPUT_SCHEMA, RECONCILE_OUTPUT_SCHEMA, ORGANIZE_OUTPUT_SCHEMA]) strict(schema);
  });

  it("make organize answer like a single-pass run did", () => {
    expect(ORGANIZE_OUTPUT_SCHEMA.required).toEqual(["outcome", "summary", "needs_input"]);
  });
});
