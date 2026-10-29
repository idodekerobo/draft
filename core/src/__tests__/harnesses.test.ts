import { describe, expect, it } from "bun:test";
import { HARNESSES, getHarness, harnessLabel, isHarnessId, isKnownModel, modelLabel } from "../harnesses";

describe("harness registry", () => {
  it("has unique ids and a default model first for every harness", () => {
    expect(new Set(HARNESSES.map((h) => h.id)).size).toBe(HARNESSES.length);
    for (const harness of HARNESSES) expect(harness.models[0]).toMatchObject({ alias: null });
  });

  it("finds a harness and falls back to the raw id for an unknown one", () => {
    expect(getHarness("claude")?.label).toBe("Claude Code");
    expect(getHarness("nope")).toBeNull();
    expect(isHarnessId("claude")).toBe(true);
    expect(isHarnessId(5)).toBe(false);
    expect(harnessLabel("nope")).toBe("nope");
  });

  it("accepts only listed model aliases of that harness", () => {
    expect(isKnownModel("claude", null)).toBe(true);
    expect(isKnownModel("claude", undefined)).toBe(true);
    expect(isKnownModel("claude", "haiku")).toBe(true);
    expect(isKnownModel("claude", "gpt-5; rm -rf /")).toBe(false);
    expect(isKnownModel("nope", "haiku")).toBe(false);
  });

  it("labels a model, naming the default and keeping an unknown alias as is", () => {
    expect(modelLabel("claude", null)).toBe("Default");
    expect(modelLabel("claude", "opus")).toBe("Opus");
    expect(modelLabel("claude", "retired")).toBe("retired");
  });
});
