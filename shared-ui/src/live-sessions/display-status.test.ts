import { describe, expect, it } from "bun:test";
import { displayStatus, IDLE_AFTER_MS } from "./display-status";

const NOW = Date.parse("2026-10-27T15:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { open_approval_count: 0, last_event_at: ago(1000), started_at: ago(5000) };

describe("displayStatus", () => {
  it("names each stored state", () => {
    expect(displayStatus({ ...base, status: "starting" }, NOW).label).toBe("Starting");
    expect(displayStatus({ ...base, status: "live" }, NOW).label).toBe("Live");
    expect(displayStatus({ ...base, status: "ended" }, NOW).label).toBe("Ended");
    expect(displayStatus({ ...base, status: "host_offline" }, NOW).label).toBe("Host offline");
  });

  it("shows Idle only for a live session with no event for more than 60 minutes", () => {
    expect(displayStatus({ ...base, status: "live", last_event_at: ago(IDLE_AFTER_MS) }, NOW).key).toBe("live");
    expect(displayStatus({ ...base, status: "live", last_event_at: ago(IDLE_AFTER_MS + 1) }, NOW).key).toBe("idle");
  });

  it("counts from the start when there was no event yet", () => {
    expect(displayStatus({ ...base, status: "live", last_event_at: null, started_at: ago(IDLE_AFTER_MS + 1) }, NOW).key).toBe("idle");
    expect(displayStatus({ ...base, status: "live", last_event_at: null }, NOW).key).toBe("live");
  });

  it("shows Waiting for approval over Live and Idle", () => {
    expect(displayStatus({ ...base, status: "live", open_approval_count: 1 }, NOW).label).toBe("Waiting for approval");
    expect(displayStatus({ ...base, status: "live", open_approval_count: 2, last_event_at: ago(IDLE_AFTER_MS * 2) }, NOW).key).toBe("waiting");
  });

  it("shows Host offline over Waiting for approval", () => {
    expect(displayStatus({ ...base, status: "host_offline", open_approval_count: 1 }, NOW).key).toBe("host_offline");
  });

  it("never shows Waiting or Idle for an ended session", () => {
    expect(displayStatus({ ...base, status: "ended", open_approval_count: 1, last_event_at: ago(IDLE_AFTER_MS * 2) }, NOW).key).toBe("ended");
  });

  it("treats a missing approval count as none", () => {
    expect(displayStatus({ status: "live", last_event_at: ago(1), started_at: ago(2) }, NOW).key).toBe("live");
  });
});
