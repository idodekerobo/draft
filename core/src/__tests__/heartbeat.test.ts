import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { checkHeartbeat } from "../heartbeat";

const TMP     = `/tmp/draft-core-heartbeat-test-${Date.now()}`;
const FAKE_BG = join(TMP, "background");
const FAKE_LOG = join(FAKE_BG, "logs", "daemon.log");

// Default opts that point all paths at the temp tree.
const opts = { backgroundDir: FAKE_BG, daemonLog: FAKE_LOG };

beforeEach(() => mkdirSync(FAKE_BG, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("checkHeartbeat", () => {
  it("returns daemonRunning:false when draft-background.pid sentinel is absent", () => {
    const result = checkHeartbeat(opts);
    expect(result.daemonRunning).toBe(false);
  });

  it("returns daemonRunning:true when draft-background.pid sentinel exists", () => {
    writeFileSync(join(FAKE_BG, "draft-background.pid"), "12345");
    const result = checkHeartbeat(opts);
    expect(result.daemonRunning).toBe(true);
  });

  it("returns lastLogLine:null when log file is absent", () => {
    const result = checkHeartbeat(opts);
    expect(result.lastLogLine).toBeNull();
  });

  it("returns last non-empty line from daemon.log", () => {
    mkdirSync(join(FAKE_BG, "logs"), { recursive: true });
    writeFileSync(FAKE_LOG, "line one\nline two\nline three\n\n");
    const result = checkHeartbeat(opts);
    expect(result.lastLogLine).toBe("line three");
  });

  it("returns lastLogLine:null for an empty log file", () => {
    mkdirSync(join(FAKE_BG, "logs"), { recursive: true });
    writeFileSync(FAKE_LOG, "\n\n\n");
    const result = checkHeartbeat(opts);
    expect(result.lastLogLine).toBeNull();
  });

  it("returns pendingQueueDepth:0 when pending/ dir is absent", () => {
    const result = checkHeartbeat(opts);
    expect(result.pendingQueueDepth).toBe(0);
  });

  it("counts .json files in pending/ dir", () => {
    const pendingDir = join(FAKE_BG, "pending");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, "job-1.json"), "{}");
    writeFileSync(join(pendingDir, "job-2.json"), "{}");
    writeFileSync(join(pendingDir, "notes.txt"), "ignored");
    const result = checkHeartbeat(opts);
    expect(result.pendingQueueDepth).toBe(2);
  });

  it("returns a complete HeartbeatResult shape on happy path", () => {
    const logDir     = join(FAKE_BG, "logs");
    const pendingDir = join(FAKE_BG, "pending");
    mkdirSync(logDir,     { recursive: true });
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(FAKE_BG, "draft-background.pid"), "99");
    writeFileSync(FAKE_LOG, "[daemon] polling\n");
    writeFileSync(join(pendingDir, "job.json"), "{}");

    const result = checkHeartbeat(opts);
    expect(result.daemonRunning).toBe(true);
    expect(result.lastLogLine).toBe("[daemon] polling");
    expect(result.pendingQueueDepth).toBe(1);
  });
});
