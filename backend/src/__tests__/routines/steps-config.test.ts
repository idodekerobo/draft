import { describe, expect, it } from "bun:test";
import type { RoutineStep } from "draft-core/routine-steps";
import { parseAgentRoutineConfig, validateAgentRoutineConfig, type AgentRoutineConfig } from "../../routines/config";
import { validateCreate } from "../../routines/validate-create";
import { validatePatch } from "../../routines/validate-patch";

const rule = { schedule: { preset: "weekly" as const, time: "09:00", weekday: "mon" as const, timezone: "America/New_York" } };
const base = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: null };

const step = (overrides: Partial<RoutineStep> = {}): RoutineStep => ({
  key: "collect",
  prompt: "Collect the facts.",
  model: null,
  permissions: [{ tool: "context.read" }],
  fanOut: { over: "none" },
  output: { type: "structured", schema: { type: "object" } },
  ...overrides,
});
const second = step({ key: "write", prompt: "Write the digest.", model: "sonnet", permissions: [{ tool: "context.read" }, { tool: "context.write" }], output: { type: "text" }, inputsFrom: ["collect"] });

describe("routine config with steps", () => {
  it("keeps the steps when the config is read back", () => {
    const config = { ...base, steps: [step(), second] };
    const result = validateAgentRoutineConfig(config);
    expect(result.ok && result.config.steps).toEqual([step(), second]);
    expect(parseAgentRoutineConfig(result.ok ? result.config : null)?.steps).toHaveLength(2);
  });

  it("leaves steps out of a routine that has none", () => {
    const result = validateAgentRoutineConfig(base);
    expect(result.ok && "steps" in result.config).toBe(false);
  });

  it("names the steps field when the list is not valid", () => {
    expect(validateAgentRoutineConfig({ ...base, steps: [{ key: "Bad Key" }] })).toEqual({ ok: false, field: "steps" });
    expect(validateAgentRoutineConfig({ ...base, steps: [step({ model: "gpt-6-luna" })] })).toEqual({ ok: false, field: "steps" });
    expect(validateAgentRoutineConfig({ ...base, steps: [step({ fanOut: { over: "source_batches", maxTokensPerBatch: 50_000 } })] })).toEqual({ ok: false, field: "steps" });
  });
});

describe("creating a routine with steps", () => {
  it("accepts steps that use what the routine may use", () => {
    const result = validateCreate({ ...base, when: rule, steps: [step(), second] });
    expect(result.ok && result.config.steps).toHaveLength(2);
  });

  it("refuses a step that asks for more than the routine has", () => {
    // Messaging is off unless the routine was saved with canNotify, so no step may use people.notify.
    const wide = step({ permissions: [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 15 } }] });
    expect(validateCreate({ ...base, when: rule, steps: [wide] })).toEqual({ ok: false, field: "steps" });
    expect(validateCreate({ ...base, when: rule, canNotify: true, steps: [wide] }).ok).toBe(true);
  });

  it("refuses a step permission with wider limits than the routine's", () => {
    const wider = step({ permissions: [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 500 } }] });
    expect(validateCreate({ ...base, when: rule, canNotify: true, steps: [wider] })).toEqual({ ok: false, field: "steps" });
  });
});

describe("changing the steps of a routine", () => {
  const current: AgentRoutineConfig = { ...base, harness: "claude", steps: [step(), second] } as AgentRoutineConfig;

  it("replaces the list", () => {
    const result = validatePatch({ steps: [step({ key: "only" })] }, "full", current);
    expect(result.ok && result.patch.agent?.steps).toEqual([step({ key: "only" })]);
  });

  it("removes the steps when null is sent", () => {
    const result = validatePatch({ steps: null }, "full", current);
    expect(result.ok && result.patch.agent && "steps" in result.patch.agent).toBe(false);
  });

  it("refuses a list that goes beyond the routine's permissions", () => {
    expect(validatePatch({ steps: [step({ permissions: [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 15 } }] })] }, "full", { ...current, steps: undefined })).toEqual({ ok: false, error: "invalid_body", field: "steps" });
  });

  it("resets every step's model to the default when the harness changes", () => {
    const result = validatePatch({ harness: "codex" }, "full", current);
    expect(result.ok && result.patch.agent?.steps?.map((entry) => entry.model)).toEqual([null, null]);
  });

  it("does not let a built-in routine take steps", () => {
    const builtIn = { prompt: "Update context.", harness: "claude" as const, model: null };
    expect(validatePatch({ steps: [step()] }, "full", null, builtIn)).toEqual({ ok: false, error: "field_not_editable", field: "steps" });
  });
});
