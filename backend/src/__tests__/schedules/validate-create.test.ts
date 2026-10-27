import { describe, expect, it } from "bun:test";
import { validateCreate } from "../../schedules/validate-create";

const valid = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku", preset: "weekly", time: "09:00", weekday: "mon", timezone: "America/New_York" };

describe("validateCreate", () => {
  it("accepts a routine with a model and a weekly schedule", () => {
    const result = validateCreate(valid);
    expect(result).toEqual({
      ok: true,
      config: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" },
      schedule: { preset: "weekly", time: "09:00", weekday: "mon", timezone: "America/New_York" },
    });
  });

  it("treats a missing model as the harness default", () => {
    const { model: _model, ...withoutModel } = valid;
    expect(validateCreate(withoutModel)).toMatchObject({ ok: true, config: { model: null } });
  });

  it.each([
    ["title", { title: "  " }],
    ["prompt", { prompt: "" }],
    ["harness", { harness: "codex" }],
    ["model", { model: "gpt-9" }],
    ["preset", { preset: "yearly" }],
    ["weekday", { weekday: "someday" }],
    ["time", { time: 900 }],
  ])("names the field %s when it is wrong", (field, change) => {
    expect(validateCreate({ ...valid, ...change })).toEqual({ ok: false, field });
  });

  it("rejects a body that is not an object", () => {
    expect(validateCreate("x")).toEqual({ ok: false, field: "body" });
    expect(validateCreate([])).toEqual({ ok: false, field: "body" });
  });
});
