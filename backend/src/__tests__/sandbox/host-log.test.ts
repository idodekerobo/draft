import { describe, expect, it } from "bun:test";
import { hostLog, redact, setRedactions } from "../../sandbox/host/log";

function captureStderr(run: () => void): string {
  const original = process.stderr.write;
  let written = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

describe("redact", () => {
  it("removes the values it is given", () => {
    expect(redact("token run-secret-1 leaked", ["run-secret-1"])).toBe("token [REDACTED] leaked");
  });

  it("removes bearer values, URL credentials and the query of a signed URL", () => {
    expect(redact("Authorization: Bearer abc.def", [])).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("fatal: https://user:pw@github.com/a/b", [])).toBe("fatal: https://[REDACTED]@github.com/a/b");
    expect(redact("GET https://files.example.test/a.tgz?X-Signature=abc failed", [])).toBe("GET https://files.example.test/a.tgz?[REDACTED] failed");
  });
});

describe("hostLog", () => {
  it("writes one JSON line and redacts every string field", () => {
    setRedactions(["run-secret-2"]);

    const line = captureStderr(() => hostLog("error", "seed_failed", { reason: "run-secret-2 was refused", attempt: 2 }));

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      source: "sandbox_host",
      level: "error",
      event: "seed_failed",
      reason: "[REDACTED] was refused",
      attempt: 2,
    });
  });

  it("cuts a long field so one failure cannot flood the log", () => {
    setRedactions([]);
    const line = captureStderr(() => hostLog("info", "long", { reason: "x".repeat(1_000) }));
    expect((JSON.parse(line) as { reason: string }).reason.length).toBe(400);
  });
});
