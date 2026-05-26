import { describe, it, expect } from "bun:test";
import { capture, spawn } from "../utils/exec.ts";

describe("capture", () => {
  it("returns exitCode 0 and stdout for successful command", async () => {
    const result = await capture(["echo", "hello world"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
  });

  it("returns non-zero exitCode and stderr for failing command", async () => {
    const result = await capture(["bash", "-c", "echo 'err msg' >&2; exit 42"]);
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe("err msg");
  });

  it("captures stdout correctly for multi-line output", async () => {
    const result = await capture(["bash", "-c", "echo line1; echo line2"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
  });

  it("times out and returns exitCode 124 when command exceeds timeoutMs", async () => {
    const result = await capture(["sleep", "10"], { timeoutMs: 200 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });
});

describe("spawn", () => {
  it("returns exit code 0 for successful command", async () => {
    const code = await spawn(["true"]);
    expect(code).toBe(0);
  });

  it("returns non-zero exit code for failing command", async () => {
    const code = await spawn(["false"]);
    expect(code).not.toBe(0);
  });
});
