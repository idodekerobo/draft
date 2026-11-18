import { describe, expect, it } from "bun:test";
import { validateCreate } from "../../schedules/validate-create";

const rule = { schedule: { preset: "weekly" as const, time: "09:00", weekday: "mon" as const, timezone: "America/New_York" } };
const valid = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku", when: rule };

describe("validateCreate", () => {
  it("accepts a routine with a model and a weekly schedule", () => {
    expect(validateCreate(valid)).toEqual({
      ok: true,
      config: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" },
      when: rule,
    });
  });

  it("passes an enabled flag through", () => {
    expect(validateCreate({ ...valid, enabled: false })).toMatchObject({ ok: true, enabled: false });
  });

  it("accepts a Codex routine with one of its own models, and not a Claude model", () => {
    expect(validateCreate({ ...valid, harness: "codex", model: "gpt-6-luna" })).toMatchObject({ ok: true, config: { harness: "codex", model: "gpt-6-luna" } });
    expect(validateCreate({ ...valid, harness: "codex", model: "haiku" })).toEqual({ ok: false, field: "model" });
  });

  it("treats a missing model as the harness default", () => {
    const { model: _model, ...withoutModel } = valid;
    expect(validateCreate(withoutModel)).toMatchObject({ ok: true, config: { model: null } });
  });

  it("refuses a missing harness, since only the run path fills one in", () => {
    const { harness: _harness, ...withoutHarness } = valid;
    expect(validateCreate(withoutHarness)).toEqual({ ok: false, field: "harness" });
  });

  it("stores a once with no triggers and no off flag", () => {
    const result = validateCreate({ ...valid, when: { in: "2h" } });
    expect(result).toEqual({ ok: true, config: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" }, when: { in: "2h" } });
  });

  it("stores a schedule that is off as onSchedule false, with its triggers", () => {
    const result = validateCreate({ ...valid, when: { schedule: null, events: ["linear.issue_created"] } });
    expect(result).toMatchObject({ ok: true, config: { events: ["linear.issue_created"], onSchedule: false } });
  });

  it("treats a rule with no schedule as off", () => {
    expect(validateCreate({ ...valid, when: { events: ["github.push"] } })).toMatchObject({ ok: true, config: { events: ["github.push"], onSchedule: false } });
  });

  it("refuses the top-level schedule fields that a client used to send, and names the first", () => {
    expect(validateCreate({ ...valid, preset: "daily", time: "09:00" })).toEqual({ ok: false, field: "preset" });
    expect(validateCreate({ ...valid, events: ["github.push"] })).toEqual({ ok: false, field: "events" });
  });

  it.each([
    ["title", { title: "  " }],
    ["prompt", { prompt: "" }],
    ["harness", { harness: "gemini" }],
    ["model", { model: "gpt-9" }],
    ["when", { when: { schedule: { preset: "yearly" } } }],
    ["when", { when: { schedule: { preset: "daily", time: 900 } } }],
    ["when", { when: { in: "soon" } }],
    ["when", { when: { events: ["not.an.event"] } }],
  ])("names the field %s when it is wrong", (field, change) => {
    expect(validateCreate({ ...valid, ...change })).toEqual({ ok: false, field });
  });

  it("rejects a body that is not an object", () => {
    expect(validateCreate("x")).toEqual({ ok: false, field: "body" });
    expect(validateCreate([])).toEqual({ ok: false, field: "body" });
  });
});
