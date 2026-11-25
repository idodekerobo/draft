import { describe, expect, it } from "bun:test";
import { harnessModes, type HarnessModel } from "../harnesses";
import { HARNESSES, cloudToolsetFor, effortAfterModelChange, effortLabel, isEffortFor, modelEfforts, getHarness, harnessInstallUrl, harnessLabel, isHarnessId, isKnownModel, isTestedVersion, modelLabel, parseCliVersion, testedVersionLabel } from "../harnesses";

describe("harness registry", () => {
  it("filters model-specific modes while inheriting axes the model does not restrict", () => {
    const model = getHarness("codex")!.models[0]! as HarnessModel;
    try {
      model.modes = { permission: ["default"], approval: [] };
      expect(harnessModes("codex", null).permission.map((mode) => mode.value)).toEqual(["default"]);
      expect(harnessModes("codex", null).approval).toEqual([]);
      model.modes = { permission: ["default"] };
      expect(harnessModes("codex", null).approval.map((mode) => mode.value)).toContain("full-access");
      expect(harnessModes("codex", "gpt-6.1-sol").permission.map((mode) => mode.value)).toContain("plan");
    } finally {
      delete model.modes;
    }
  });
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
    expect(parseCliVersion("codex-cli 0.169.0")).toBe("0.169.0");
    expect(parseCliVersion("no version")).toBeNull();
    expect(isTestedVersion("claude", "2.1.311")).toBe(true);
    expect(isTestedVersion("claude", "2.2.0")).toBe(false);
    expect(isTestedVersion("claude", "0.165.0")).toBe(false);
    expect(isTestedVersion("codex", "0.169.0")).toBe(true);
    expect(isTestedVersion("codex", "0.170.1")).toBe(false);
    expect(isTestedVersion("claude", null)).toBeNull();
    expect(isTestedVersion("nope", "1.0.0")).toBeNull();
    expect(testedVersionLabel("codex")).toBe("0.169.x");
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

describe("cloudToolsetFor", () => {
  it("is the starting tools for a run that chose nothing", () => {
    expect(cloudToolsetFor("claude")).toMatchObject({ nativeTools: [{ harness: "claude", tool: "Read" }, { harness: "claude", tool: "Glob" }], mcpServers: [] });
    expect(cloudToolsetFor("codex").nativeTools).toEqual([{ harness: "codex", tool: "shell" }]);
  });

  it("adds what was chosen once, and never a tool outside the cloud list", () => {
    const toolset = cloudToolsetFor("claude", { nativeTools: ["WebSearch", "Read", "Write"] });
    expect(toolset.nativeTools.map((tool) => tool.tool)).toEqual(["Read", "Glob", "WebSearch", "Write"]);
    expect(cloudToolsetFor("codex", { nativeTools: ["apply_patch", "web_search"] }).nativeTools.map((tool) => tool.tool)).toEqual(["shell", "web_search"]);
  });
});

describe("reasoning efforts", () => {
  it("lists efforts per model, and the Luna models stop at max", () => {
    expect(modelEfforts("codex", "gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(modelEfforts("codex", "gpt-6-luna")).not.toContain("ultra");
    expect(modelEfforts("claude", "opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelEfforts("claude", "retired")).toEqual([]);
  });

  it("accepts no effort for every model, and an effort only where the model lists it", () => {
    expect(isEffortFor("codex", "gpt-6-luna", null)).toBe(true);
    expect(isEffortFor("codex", "gpt-6-luna", "ultra")).toBe(false);
    expect(isEffortFor("codex", "gpt-6-sol", "ultra")).toBe(true);
  });

  it("keeps the effort across a model change when allowed, else uses the new model's default", () => {
    expect(effortAfterModelChange("codex", "gpt-6-sol", "high")).toBe("high");
    expect(effortAfterModelChange("codex", "gpt-6-luna", "ultra")).toBe("medium");
    expect(effortAfterModelChange("claude", "sonnet", "ultra")).toBe(null);
    expect(effortAfterModelChange("codex", "gpt-6-luna", null)).toBe(null);
  });

  it("labels efforts", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("weird")).toBe("weird");
  });

  it("gives every model a default effort it accepts", () => {
    for (const harness of HARNESSES) {
      for (const model of harness.models) if (model.defaultEffort) expect(model.efforts).toContain(model.defaultEffort);
    }
  });
});
