import { describe, expect, it } from "bun:test";
import { sessionBanner } from "./session-banner";

const base = { status: "live" as const, owner_name: "Maya", harness_version: "2.1.311" };

describe("sessionBanner", () => {
  it("says nothing for a healthy session on a tested version", () => {
    expect(sessionBanner(base)).toBeNull();
    expect(sessionBanner({ ...base, harness_version: null })).toBeNull();
  });

  it("says nothing for a sleeping session, since sleep is a normal state", () => {
    expect(sessionBanner({ ...base, status: "sleeping" })).toBeNull();
  });

  it("says the host is offline and that messages wait", () => {
    expect(sessionBanner({ ...base, status: "host_offline" })).toBe("Maya's computer is offline. Messages wait until it is back.");
    expect(sessionBanner({ ...base, status: "host_offline", owner_name: null })).toContain("The owner's computer");
  });

  it("shows no banner for a cloud session, since Draft restarts it", () => {
    expect(sessionBanner({ ...base, status: "host_offline", execution_target: "sandbox" })).toBeNull();
  });

  it("warns about an untested Claude version, but not for an ended session", () => {
    expect(sessionBanner({ ...base, harness_version: "2.2.0" }, true)).toContain("[DEV ONLY] This session runs Claude Code 2.2.0");
    expect(sessionBanner({ ...base, harness_version: "2.2.0", status: "ended" }, true)).toBeNull();
  });

  it("checks a Codex session against the Codex version, never the Claude one", () => {
    expect(sessionBanner({ ...base, harness: "codex", harness_version: "0.165.0" }, true)).toBeNull();
    expect(sessionBanner({ ...base, harness: "codex", harness_version: "0.170.0" }, true)).toContain("[DEV ONLY] This session runs Codex 0.170.0");
    expect(sessionBanner({ ...base, harness: "codex", harness_version: "0.170.0" }, true)).toContain("0.165.x");
  });

  it("puts Host offline before the version warning", () => {
    expect(sessionBanner({ ...base, status: "host_offline", harness_version: "2.2.0" })).toContain("offline");
  });
});
