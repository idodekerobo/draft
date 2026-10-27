import { describe, expect, it } from "bun:test";
import { rotationTarget } from "./rotation";

describe("rotationTarget", () => {
  it("returns the new id after /clear or /fork", () => {
    expect(rotationTarget("n1", { source: "clear", session_id: "n2" })).toBe("n2");
    expect(rotationTarget("n1", { source: "resume", session_id: "n2" })).toBe("n2");
  });

  it("ignores the start of the session the host launched", () => {
    expect(rotationTarget("n1", { source: "startup", session_id: "n1" })).toBeNull();
  });

  it("ignores a compact and a payload without an id", () => {
    expect(rotationTarget("n1", { source: "compact", session_id: "n2" })).toBeNull();
    expect(rotationTarget("n1", { source: "clear" })).toBeNull();
    expect(rotationTarget("n1", { session_id: 5 })).toBeNull();
  });
});
