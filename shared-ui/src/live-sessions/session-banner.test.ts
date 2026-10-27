import { describe, expect, it } from "bun:test";
import { sessionBanner } from "./session-banner";

const base = { status: "live" as const, owner_name: "Maya", harness_version: "2.1.311" };

describe("sessionBanner", () => {
  it("says nothing for a healthy session on a tested version", () => {
    expect(sessionBanner(base)).toBeNull();
    expect(sessionBanner({ ...base, harness_version: null })).toBeNull();
  });

  it("says the host is offline and that messages wait", () => {
    expect(sessionBanner({ ...base, status: "host_offline" })).toBe("Maya's computer is offline. Messages wait until it is back.");
    expect(sessionBanner({ ...base, status: "host_offline", owner_name: null })).toContain("The owner's computer");
  });

  it("warns about an untested Claude version, but not for an ended session", () => {
    expect(sessionBanner({ ...base, harness_version: "2.2.0" })).toContain("Claude Code 2.2.0");
    expect(sessionBanner({ ...base, harness_version: "2.2.0", status: "ended" })).toBeNull();
  });

  it("puts Host offline before the version warning", () => {
    expect(sessionBanner({ ...base, status: "host_offline", harness_version: "2.2.0" })).toContain("offline");
  });
});
