import { describe, expect, it } from "bun:test";
import { checkRoutineSteps, hasSteps, permissionsBeyondRoutine, resolveStepPermissions, stepsOf, type RoutineStep } from "../routine-steps";
import type { AnyDraftToolPermission } from "../tools";

const routinePermissions: AnyDraftToolPermission[] = [
  { tool: "context.read" },
  { tool: "context.write" },
  { tool: "people.notify", limits: { recipients: "members", maxPerRun: 15 } },
];

const step = (overrides: Partial<RoutineStep> = {}): RoutineStep => ({
  key: "draft_reply",
  prompt: "Draft a reply.",
  model: null,
  permissions: [{ tool: "context.read" }],
  fanOut: { over: "none" },
  output: { type: "text" },
  ...overrides,
});

const context = { harness: "claude" as const, routinePermissions, allowSourceBatches: false };

describe("stepsOf", () => {
  it("reads a routine with no steps as one step built from its prompt, model and permissions", () => {
    const [only, ...rest] = stepsOf({ prompt: "Summarize the week.", model: "haiku", permissions: routinePermissions });
    expect(rest).toEqual([]);
    expect(only).toEqual({ key: "main", prompt: "Summarize the week.", model: "haiku", permissions: routinePermissions, fanOut: { over: "none" }, output: { type: "text" } });
  });

  it("returns the routine's own steps when it has them", () => {
    const steps = [step(), step({ key: "second" })];
    expect(stepsOf({ steps, prompt: "ignored", model: null, permissions: [] })).toEqual(steps);
  });

  it("treats an empty list as no steps", () => {
    expect(hasSteps({ steps: [] })).toBe(false);
    expect(hasSteps({})).toBe(false);
    expect(hasSteps({ steps: [step()] })).toBe(true);
    expect(stepsOf({ steps: [], prompt: "p", model: null, permissions: [] })[0]!.key).toBe("main");
  });
});

describe("permission narrowing", () => {
  it("allows a subset with the same tool, provider and limits", () => {
    const narrow = step({ permissions: [{ tool: "context.read" }, { tool: "people.notify", limits: { maxPerRun: 15, recipients: "members" } }] });
    expect(permissionsBeyondRoutine(narrow, routinePermissions)).toEqual([]);
  });

  it("refuses a tool the routine does not have", () => {
    expect(permissionsBeyondRoutine(step({ permissions: [{ tool: "routines.delete" }] }), routinePermissions)).toEqual([{ tool: "routines.delete" }]);
  });

  it("refuses wider limits than the routine's", () => {
    const wider = step({ permissions: [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 500 } }] });
    expect(permissionsBeyondRoutine(wider, routinePermissions)).toHaveLength(1);
    expect(permissionsBeyondRoutine(step({ permissions: [{ tool: "people.notify" }] }), routinePermissions)).toHaveLength(1);
  });

  it("gives a step with no list everything the routine has, and no more", () => {
    const open = step({ permissions: undefined });
    expect(permissionsBeyondRoutine(open, routinePermissions)).toEqual([]);
    expect(resolveStepPermissions(open, routinePermissions)).toEqual(routinePermissions);
    expect(checkRoutineSteps([open], context).ok).toBe(true);
  });

  it("keeps only what the routine still grants when a step runs", () => {
    const wanted = step({ permissions: [{ tool: "context.read" }, { tool: "context.write" }] });
    expect(resolveStepPermissions(wanted, [{ tool: "context.read" }])).toEqual([{ tool: "context.read" }]);
  });
});

describe("checkRoutineSteps", () => {
  it("accepts a valid list and returns it", () => {
    const steps = [step({ key: "collect", output: { type: "structured", schema: { type: "object" } } }), step({ key: "write", inputsFrom: ["collect"], model: "sonnet" })];
    expect(checkRoutineSteps(steps, context)).toEqual({ ok: true, steps });
  });

  it("refuses a malformed list", () => {
    for (const bad of [null, [], "x", [{}], [step({ key: "Bad Key" })], [{ ...step(), extra: 1 }], [step({ prompt: "  " })], Array.from({ length: 11 }, (_, index) => step({ key: `s${index}` }))]) {
      expect(checkRoutineSteps(bad, context)).toEqual({ ok: false, problem: { code: "invalid_shape" } });
    }
  });

  it("refuses a repeated key, a model the harness does not have, and an input from a later step", () => {
    expect(checkRoutineSteps([step(), step()], context)).toEqual({ ok: false, problem: { code: "duplicate_key", key: "draft_reply" } });
    expect(checkRoutineSteps([step({ model: "gpt-6-luna" })], context)).toEqual({ ok: false, problem: { code: "bad_model", key: "draft_reply" } });
    expect(checkRoutineSteps([step({ inputsFrom: ["later"] }), step({ key: "later" })], context)).toEqual({ ok: false, problem: { code: "bad_input", key: "draft_reply" } });
  });

  it("checks the model against the routine's harness", () => {
    expect(checkRoutineSteps([step({ model: "gpt-6-luna" })], { ...context, harness: "codex" }).ok).toBe(true);
    expect(checkRoutineSteps([step({ model: "haiku" })], { ...context, harness: "codex" })).toEqual({ ok: false, problem: { code: "bad_model", key: "draft_reply" } });
  });

  it("keeps the allowPartial flag", () => {
    const result = checkRoutineSteps([step({ allowPartial: true })], context);
    expect(result.ok && result.steps[0]!.allowPartial).toBe(true);
    expect(checkRoutineSteps([{ ...step(), allowPartial: "yes" }], context)).toEqual({ ok: false, problem: { code: "invalid_shape" } });
  });

  it("allows source batches only when the routine consumes sources", () => {
    const batches = step({ fanOut: { over: "source_batches", maxTokensPerBatch: 50_000 } });
    expect(checkRoutineSteps([batches], context)).toEqual({ ok: false, problem: { code: "fan_out_not_allowed", key: "draft_reply" } });
    expect(checkRoutineSteps([batches], { ...context, allowSourceBatches: true }).ok).toBe(true);
    expect(checkRoutineSteps([step({ fanOut: { over: "context_documents", filter: "all_stable" } })], context).ok).toBe(true);
  });

  it("refuses a permission beyond the routine's, and skips the check when the routine's are not known", () => {
    const wide = step({ permissions: [{ tool: "routines.delete" }] });
    expect(checkRoutineSteps([wide], context)).toEqual({ ok: false, problem: { code: "permission_beyond_routine", key: "draft_reply", tool: "routines.delete" } });
    expect(checkRoutineSteps([wide], { ...context, routinePermissions: null }).ok).toBe(true);
  });

  it("refuses an unknown tool name and an output schema that is too large", () => {
    expect(checkRoutineSteps([{ ...step(), permissions: [{ tool: "no.such_tool" }] }], context)).toEqual({ ok: false, problem: { code: "invalid_shape" } });
    const huge = step({ output: { type: "structured", schema: { description: "x".repeat(21_000) } } });
    expect(checkRoutineSteps([huge], context)).toEqual({ ok: false, problem: { code: "too_large", key: "draft_reply" } });
  });
});
