import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { getAppState } from "../appState";

const TMP = `/tmp/draft-core-app-state-test-${Date.now()}`;
const ACTIVE_PROFILE_FILE = join(TMP, "active-profile");
const WORKSPACES_DIR = join(TMP, "workspaces");
const BACKGROUND_DIR = join(TMP, "background");
const NOW = new Date("2026-05-29T12:00:00Z").getTime();

beforeEach(() => {
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  mkdirSync(join(BACKGROUND_DIR, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function opts() {
  return {
    activeProfileFile: ACTIVE_PROFILE_FILE,
    workspacesDir: WORKSPACES_DIR,
    backgroundDir: BACKGROUND_DIR,
    nowMs: NOW,
  };
}

function writeHeartbeat(ageMs: number) {
  const path = join(BACKGROUND_DIR, "state", "last-heartbeat");
  writeFileSync(path, "{}");
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("getAppState", () => {
  it("returns no-profile when active-profile is missing", () => {
    const result = getAppState(opts());
    expect(result.userState).toBe("no-profile");
    expect(result.hasActiveProfile).toBe(false);
    expect(result.activeProfile).toBe("default");
  });

  it("returns no-context when profile exists but context has no markdown files", () => {
    writeFileSync(ACTIVE_PROFILE_FILE, "acme\n");
    mkdirSync(join(WORKSPACES_DIR, "acme", "context"), { recursive: true });
    const result = getAppState(opts());
    expect(result.userState).toBe("no-context");
    expect(result.hasContextFiles).toBe(false);
  });

  it("returns ready-running when context exists and heartbeat is fresh", () => {
    writeFileSync(ACTIVE_PROFILE_FILE, "acme\n");
    mkdirSync(join(WORKSPACES_DIR, "acme", "context", "product"), { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "acme", "context", "product", "index.md"), "# Product\n");
    writeHeartbeat(30_000);
    const result = getAppState(opts());
    expect(result.userState).toBe("ready-running");
    expect(result.daemonState).toBe("running");
  });

  it("returns ready-stopped when context exists and heartbeat is stale", () => {
    writeFileSync(ACTIVE_PROFILE_FILE, "acme\n");
    mkdirSync(join(WORKSPACES_DIR, "acme", "context", "company"), { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "acme", "context", "company", "index.md"), "# Company\n");
    writeHeartbeat(3 * 60 * 1000);
    const result = getAppState(opts());
    expect(result.userState).toBe("ready-stopped");
    expect(result.daemonState).toBe("stopped");
  });

  it("treats missing heartbeat as ready-daemon-stopped once context exists", () => {
    writeFileSync(ACTIVE_PROFILE_FILE, "acme\n");
    mkdirSync(join(WORKSPACES_DIR, "acme", "context", "team"), { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "acme", "context", "team", "index.md"), "# Team\n");
    const result = getAppState(opts());
    expect(result.userState).toBe("ready-stopped");
    expect(result.daemonState).toBe("never-started");
    expect(result.heartbeatAgeMs).toBe(null);
  });
});
