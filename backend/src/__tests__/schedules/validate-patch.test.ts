import { describe, expect, it } from "bun:test";
import { validatePatch } from "../../schedules/validate-patch";
import { parseAgentRoutineConfig, type AgentRoutineConfig } from "../../routines/config";

const current: AgentRoutineConfig = { title: "Digest", prompt: "Summarize.", harness: "claude", model: null };

describe("validatePatch for an agent routine", () => {
  it("merges the sent fields into the stored config", () => {
    const result = validatePatch({ prompt: "Summarize more." }, "full", current);
    expect(result).toEqual({ ok: true, patch: { agent: { ...current, prompt: "Summarize more." } } });
  });

  it("trims the title", () => {
    const result = validatePatch({ title: "  New  " }, "full", current);
    expect(result.ok && result.patch.agent?.title).toBe("New");
  });

  it("drops the old model when the harness changes and no model is sent", () => {
    const withModel = { ...current, model: "claude-opus-5-5" };
    const result = validatePatch({ harness: "codex" }, "full", withModel);
    expect(result.ok && result.patch.agent).toMatchObject({ harness: "codex", model: null });
  });

  it("keeps the model that is sent with a new harness", () => {
    const result = validatePatch({ harness: "codex", model: "gpt-6-luna" }, "full", current);
    expect(result.ok && result.patch.agent).toMatchObject({ harness: "codex", model: "gpt-6-luna" });
  });

  it("names the field that is wrong", () => {
    expect(validatePatch({ harness: "gemini" }, "full", current)).toEqual({ ok: false, error: "invalid_body", field: "harness" });
    expect(validatePatch({ model: "nope" }, "full", current)).toEqual({ ok: false, error: "invalid_body", field: "model" });
    expect(validatePatch({ title: "" }, "full", current)).toEqual({ ok: false, error: "invalid_body", field: "title" });
  });

  it("allows an agent field together with enabled", () => {
    const result = validatePatch({ enabled: false, prompt: "New." }, "full", current);
    expect(result.ok && result.patch).toMatchObject({ enabled: false, agent: { prompt: "New." } });
  });

  it("keeps events and canNotify through an edit of the title, since a patch merges onto the stored config", () => {
    const stored = parseAgentRoutineConfig({ ...current, events: ["fireflies.meeting_summarized"], canNotify: true })!;
    const result = validatePatch({ title: "Renamed" }, "full", stored);
    expect(result).toMatchObject({ ok: true, patch: { agent: { title: "Renamed", events: ["fireflies.meeting_summarized"], canNotify: true } } });
  });

  it("refuses agent fields for a routine with no agent config", () => {
    expect(validatePatch({ prompt: "New." }, "full", null)).toEqual({ ok: false, error: "field_not_editable", field: "prompt" });
  });
});

describe("validatePatch reasoning effort", () => {
  const withEffort = { ...current, harness: "codex" as const, model: "gpt-6-sol", reasoningEffort: "ultra" };

  it("accepts an effort the model lists and clears it with null", () => {
    expect(validatePatch({ reasoningEffort: "high" }, "full", withEffort).ok && (validatePatch({ reasoningEffort: "high" }, "full", withEffort) as { patch: { agent: AgentRoutineConfig } }).patch.agent.reasoningEffort).toBe("high");
    const cleared = validatePatch({ reasoningEffort: null }, "full", withEffort);
    expect(cleared.ok && "reasoningEffort" in cleared.patch.agent!).toBe(false);
  });

  it("refuses an effort the model does not list", () => {
    expect(validatePatch({ model: "gpt-6-luna", reasoningEffort: "ultra" }, "full", withEffort)).toEqual({ ok: false, error: "invalid_body", field: "reasoningEffort" });
  });

  it("drops the old effort when the model changes and no effort is sent", () => {
    const result = validatePatch({ model: "gpt-6-luna" }, "full", withEffort);
    expect(result.ok && "reasoningEffort" in result.patch.agent!).toBe(false);
  });

  it("keeps the effort when only the prompt changes", () => {
    const result = validatePatch({ prompt: "Again." }, "full", withEffort);
    expect(result.ok && result.patch.agent?.reasoningEffort).toBe("ultra");
  });
});
