import { describe, expect, it } from "bun:test";
import { HARNESSES } from "draft-core/harnesses";
import { registrationFor } from "./drivers";

describe("registrationFor", () => {
  it("has a launcher for every harness in the registry", () => {
    for (const harness of HARNESSES) expect(registrationFor(harness.id).launcher.id).toBe(harness.id);
  });

  it("treats a state file with no harness, or an unknown one, as Claude", () => {
    expect(registrationFor(undefined).launcher.id).toBe("claude");
    expect(registrationFor("future").launcher.id).toBe("claude");
  });
});
