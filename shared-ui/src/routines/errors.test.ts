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
});
