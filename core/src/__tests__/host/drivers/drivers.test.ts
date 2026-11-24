import { describe, expect, it } from "bun:test";
import { ADAPTERS, interactiveAdapterFor } from "../../../harnesses";
import { registrationFor } from "../../../host/drivers/drivers";

describe("registrationFor", () => {
  it("has a launcher for every adapter that runs on a host", () => {
    for (const adapter of ADAPTERS.filter((entry) => (entry.targets as ReadonlyArray<string>).includes("host"))) {
      expect(registrationFor(adapter.id).launcher.id).toBe(adapter.harness);
    }
  });

  it("finds the live-session adapter of each harness", () => {
    expect(registrationFor(interactiveAdapterFor("claude")!.id).launcher.id).toBe("claude");
    expect(registrationFor(interactiveAdapterFor("codex")!.id).launcher.id).toBe("codex");
  });

  it("fails for a missing or unknown adapter, and for one that has no host driver", () => {
    expect(() => registrationFor(undefined)).toThrow("Unknown adapter");
    expect(() => registrationFor("future")).toThrow("Unknown adapter");
    expect(() => registrationFor("claude-print")).toThrow("no host driver");
  });
});
