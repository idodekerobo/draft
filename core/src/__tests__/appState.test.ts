import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getAppState } from "../appState";

const TMP = `/tmp/draft-core-app-state-test-${Date.now()}`;
const ACTIVE_PROFILE_FILE = join(TMP, "active-profile");
const WORKSPACES_DIR = join(TMP, "workspaces");

beforeEach(() => {
  mkdirSync(WORKSPACES_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function opts() {
  return { activeProfileFile: ACTIVE_PROFILE_FILE, workspacesDir: WORKSPACES_DIR };
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

  it("returns ready when context has markdown files", () => {
    writeFileSync(ACTIVE_PROFILE_FILE, "acme\n");
    mkdirSync(join(WORKSPACES_DIR, "acme", "context", "product"), { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "acme", "context", "product", "index.md"), "# Product\n");
    const result = getAppState(opts());
    expect(result.userState).toBe("ready");
    expect(result.hasContextFiles).toBe(true);
  });
});
