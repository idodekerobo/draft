import { describe, expect, it } from "bun:test";
import { HARNESSES, getHarness, harnessInstallUrl, harnessLabel, isHarnessId, isKnownModel, isTestedVersion, modelLabel, parseCliVersion, testedVersionLabel } from "../harnesses";

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

  it("reads a CLI version and accepts the tested minor of that harness only", () => {
    expect(parseCliVersion("2.1.311 (Claude Code)\n")).toBe("2.1.311");
    expect(parseCliVersion("codex-cli 0.165.0")).toBe("0.165.0");
    expect(parseCliVersion("no version")).toBeNull();
    expect(isTestedVersion("claude", "2.1.311")).toBe(true);
    expect(isTestedVersion("claude", "2.2.0")).toBe(false);
    expect(isTestedVersion("claude", "0.165.0")).toBe(false);
    expect(isTestedVersion("codex", "0.165.0")).toBe(true);
    expect(isTestedVersion("codex", "0.166.1")).toBe(false);
    expect(isTestedVersion("claude", null)).toBeNull();
    expect(isTestedVersion("nope", "1.0.0")).toBeNull();
    expect(testedVersionLabel("codex")).toBe("0.165.x");
  });

  it("gives the install page of a harness that has one", () => {
    expect(harnessInstallUrl("codex")).toBe("https://learn.chatgpt.com/docs/codex/cli#getting-started");
    expect(harnessInstallUrl("claude")).toBeNull();
    expect(harnessInstallUrl("nope")).toBeNull();
  });

  it("labels a model, naming the default and keeping an unknown alias as is", () => {
    expect(modelLabel("claude", null)).toBe("Default");
    expect(modelLabel("claude", "opus")).toBe("Opus");
    expect(modelLabel("claude", "retired")).toBe("retired");
  });
});
