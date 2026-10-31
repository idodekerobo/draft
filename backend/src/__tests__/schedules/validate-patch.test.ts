import { describe, expect, it } from "bun:test";
import { validatePatch } from "../../schedules/validate-patch";
import type { AgentRoutineConfig } from "../../routines/config";

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

  it("refuses agent fields for a routine with no agent config", () => {
    expect(validatePatch({ prompt: "New." }, "full", null)).toEqual({ ok: false, error: "field_not_editable", field: "prompt" });
  });
});
