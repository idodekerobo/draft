import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the exec module BEFORE importing status — Bun evaluates mock.module
// synchronously before the first import of the mocked path.
//
// We expose a mutable ref so each test can swap in a different launchctl response.
let mockCaptureImpl: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;

mock.module("../exec", () => ({
  capture: (..._args: unknown[]) => mockCaptureImpl(),
  spawn:   (..._args: unknown[]) => Promise.resolve(0),
}));

// Import AFTER mock is registered.
const { getDaemonStatus } = await import("../status");

// ── launchctl output fixtures ─────────────────────────────────────────────────

/** launchctl output when daemon is registered AND running (has PID). */
const RUNNING_OUTPUT = `{
\t"LimitLoadToSessionType" = "Aqua";
\t"Label" = "com.draft.daemon";
\t"LastExitStatus" = 0;
\t"PID" = 12345;
\t"Program" = "/usr/local/bin/bash";
};`;

/** launchctl output when daemon is registered but NOT running (no PID). */
const DEGRADED_OUTPUT = `{
\t"LimitLoadToSessionType" = "Aqua";
\t"Label" = "com.draft.daemon";
\t"LastExitStatus" = 1;
};`;

// ── tests ────────────────────────────────────────────────────────────────────────

describe("getDaemonStatus", () => {
  it("returns state:running when launchctl reports a PID", async () => {
    mockCaptureImpl = async () => ({ exitCode: 0, stdout: RUNNING_OUTPUT, stderr: "" });
    const status = await getDaemonStatus();
    expect(status.state).toBe("running");
    expect(status.pid).toBe("12345");
    expect(status.lastExit).toBe("0");
    expect(status.isRegistered).toBe(true);
  });

  it("returns state:degraded when registered but no PID in output", async () => {
    mockCaptureImpl = async () => ({ exitCode: 0, stdout: DEGRADED_OUTPUT, stderr: "" });
    const status = await getDaemonStatus();
    expect(status.state).toBe("degraded");
    expect(status.pid).toBeNull();
    expect(status.lastExit).toBe("1");
    expect(status.isRegistered).toBe(true);
  });

  it("returns state:stopped when launchctl exits non-zero (not registered)", async () => {
    mockCaptureImpl = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Could not find service com.draft.daemon",
    });
    const status = await getDaemonStatus();
    expect(status.state).toBe("stopped");
    expect(status.pid).toBeNull();
    expect(status.isRegistered).toBe(false);
  });

  it("returns state:stopped when launchctl binary is not found (exitCode 127)", async () => {
    mockCaptureImpl = async () => ({ exitCode: 127, stdout: "", stderr: "command not found" });
    const status = await getDaemonStatus();
    expect(status.state).toBe("stopped");
    expect(status.isRegistered).toBe(false);
  });

  it("handles malformed launchctl output gracefully (no PID or exit match)", async () => {
    mockCaptureImpl = async () => ({
      exitCode: 0,
      stdout: '{ "Label" = "com.draft.daemon"; };',
      stderr: "",
    });
    const status = await getDaemonStatus();
    // registered (exitCode 0) but no PID → degraded
    expect(status.state).toBe("degraded");
    expect(status.pid).toBeNull();
    expect(status.lastExit).toBeNull();
  });
});
