import { describe, expect, it } from "bun:test";
import { cloudStartNotice, elapsedLabel, hostWaitOf } from "./cloud-start-notice";

const base = { status: "starting" as const, started_at: "2026-11-19T20:00:00Z", folder_name: "draft", runtime: "cloud" as const, last_seq: 0, end_reason: null };

describe("cloudStartNotice", () => {
  it("says the machine is starting, names the repository, and that the message waits", () => {
    expect(cloudStartNotice(base)).toMatchObject({ tone: "progress", title: "Starting Draft cloud" });
    expect(cloudStartNotice(base)?.detail).toContain("copying in draft");
  });

  it("says a session with history is waking", () => {
    expect(cloudStartNotice({ ...base, last_seq: 12 })?.title).toBe("Waking this session");
  });

  it("explains a start that failed, and nothing for a session that ended normally or ran on a computer", () => {
    expect(cloudStartNotice({ ...base, status: "ended", end_reason: "seed_failed" })).toMatchObject({ tone: "error", title: "This session could not start" });
    expect(cloudStartNotice({ ...base, status: "ended", end_reason: "user_exit" })).toBeNull();
    expect(cloudStartNotice({ ...base, status: "ended", end_reason: "host_failed", last_seq: 30 })).toBeNull();
    expect(cloudStartNotice({ ...base, runtime: "local" })).toBeNull();
    expect(cloudStartNotice({ ...base, status: "live" })).toBeNull();
  });
});

describe("hostWaitOf", () => {
  it("tells starting, waking, restarting and an offline computer apart", () => {
    expect(hostWaitOf(base)).toBe("cloud_starting");
    expect(hostWaitOf({ ...base, last_seq: 3 })).toBe("cloud_waking");
    expect(hostWaitOf({ ...base, status: "host_offline" })).toBe("cloud");
    expect(hostWaitOf({ ...base, status: "host_offline", runtime: "local" })).toBe("local");
    expect(hostWaitOf({ ...base, status: "live" })).toBe(false);
  });
});

describe("elapsedLabel", () => {
  it("shows minutes and seconds", () => {
    expect(elapsedLabel("2026-11-19T20:00:00Z", Date.parse("2026-11-19T20:01:05Z"))).toBe("1:05");
  });
});
