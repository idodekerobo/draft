import { describe, expect, it } from "bun:test";
import { toRoutineError } from "./errors";

describe("toRoutineError", () => {
  it("tells the member to connect Codex, beside the agent field", () => {
    const error = toRoutineError("codex_not_connected", "harness");
    expect(error.message).toBe("Connect Codex for routines first.");
    expect(error.field).toBe("harness");
  });

  it("keeps the old messages", () => {
    expect(toRoutineError("invalid_body", "harness").message).toBe("Choose an agent.");
    expect(toRoutineError("not_found").message).toContain("no longer exists");
  });

  it("explains a time too far away or already past, beside When it runs", () => {
    const tooFar = toRoutineError("too_far_ahead");
    expect(tooFar.message).toContain("365 days");
    expect(tooFar.field).toBe("when");
    const past = toRoutineError("in_the_past");
    expect(past.message).toBe("That time has already passed. Pick a later time.");
    expect(past.field).toBe("when");
  });

  it("finds the control a nested when field names", () => {
    const time = toRoutineError("invalid_schedule", "when.schedule.time");
    expect(time.message).toBe("Enter a valid time.");
    expect(time.field).toBe("time");
    expect(toRoutineError("invalid_schedule", "when.events.0").field).toBe("events");
    expect(toRoutineError("invalid_body", "when.in").field).toBe("when");
  });

  it("puts a schedule error with no known control beside When it runs", () => {
    const error = toRoutineError("invalid_schedule");
    expect(error.message).toBe("Choose a valid schedule and try again.");
    expect(error.field).toBe("when");
  });

  it("shows the routine limit with no field, so it is never hidden", () => {
    const error = toRoutineError("invalid_schedule", "limit");
    expect(error.message).toContain("limit of routines");
    expect(error.field).toBeUndefined();
  });

  it("uses the general message for an error it does not know", () => {
    expect(toRoutineError("schedules_create_failed").message).toBe("Could not save this schedule. Try again.");
  });
});
