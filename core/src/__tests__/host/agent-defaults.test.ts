import { describe, expect, it } from "bun:test";
import { claudeDefaultsFrom, claudeModelName, codexDefaultsFrom } from "../../host/agent-defaults";

describe("claudeDefaultsFrom", () => {
  const settings = {
    model: "sonnet",
    effortLevel: "medium",
    modelSettings: { "claude-sonnet-5": { effortLevel: "medium" }, "claude-sonnet-5-5": { effortLevel: "low" }, "claude-haiku-5-5": { effortLevel: "high" } },
  };

  it("names the saved model and the effort saved for its newest version", () => {
    expect(claudeDefaultsFrom(settings)).toEqual({ model: "sonnet", modelLabel: "Sonnet 5.5", effort: "low" });
  });

  it("falls back to the top-level effort, then to the alias label", () => {
    expect(claudeDefaultsFrom({ model: "opus", effortLevel: "high" })).toEqual({ model: "opus", modelLabel: "Opus", effort: "high" });
  });

  it("gives nothing when no model is saved or the file is not settings", () => {
    expect(claudeDefaultsFrom({ effortLevel: "low" }).model).toBeNull();
    expect(claudeDefaultsFrom(null).model).toBeNull();
    expect(claudeDefaultsFrom("x").effort).toBeNull();
  });
});

describe("claudeModelName", () => {
  it("reads the family and version from an id", () => {
    expect(claudeModelName("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(claudeModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(claudeModelName("something-else")).toBeNull();
  });
});

describe("codexDefaultsFrom", () => {
  it("reads the top-level keys only", () => {
    const toml = 'model = "gpt-6-luna"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.fast]\nmodel = "gpt-5.6-sol"\n';
    expect(codexDefaultsFrom(toml)).toEqual({ model: "gpt-6-luna", modelLabel: "GPT-6-Luna", effort: "xhigh" });
  });

  it("gives nothing for an empty file", () => {
    expect(codexDefaultsFrom("").model).toBeNull();
  });
});
