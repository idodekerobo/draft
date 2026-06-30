import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  readSecrets,
  writeSecrets,
  readCollaboration,
  getActiveProfile,
  getProfiles,
  setActiveProfile,
  getSkillManifestPath,
  getMcpManifestPath,
} from "../config";

const TMP = `/tmp/draft-core-test-${Date.now()}`;

beforeEach(() => mkdirSync(join(TMP, "config"), { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("readSecrets", () => {
  it("returns ok:true for valid JSON", () => {
    writeFileSync(
      join(TMP, "config", "secrets.json"),
      JSON.stringify({ granola_mode: "mcp", slack_bot_token: "xoxb-test" })
    );
    const result = readSecrets(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets.granola_mode).toBe("mcp");
      expect(result.secrets.slack_bot_token).toBe("xoxb-test");
    }
  });

  it("returns ok:false reason:missing when file does not exist", () => {
    const result = readSecrets(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("returns ok:false reason:malformed for invalid JSON", () => {
    writeFileSync(join(TMP, "config", "secrets.json"), "not json {{{");
    const result = readSecrets(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("returns ok:true with empty object for missing keys (all keys optional)", () => {
    writeFileSync(join(TMP, "config", "secrets.json"), "{}");
    const result = readSecrets(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets.granola_mode).toBeUndefined();
      expect(result.secrets.slack_bot_token).toBeUndefined();
      expect(result.secrets.github_connected).toBeUndefined();
    }
  });

  it("merges a secrets patch without overwriting other integration credentials", () => {
    writeFileSync(
      join(TMP, "config", "secrets.json"),
      JSON.stringify({ slack_bot_token: "xoxb-existing", slack_app_token: "xapp-existing" }),
    );

    writeSecrets(TMP, { granola_mode: "api", granola_api_token: "granola-token" });

    const result = readSecrets(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets.slack_bot_token).toBe("xoxb-existing");
      expect(result.secrets.slack_app_token).toBe("xapp-existing");
      expect(result.secrets.granola_mode).toBe("api");
      expect(result.secrets.granola_api_token).toBe("granola-token");
    }
  });
});

describe("readCollaboration", () => {
  it("returns ok:true for valid collab config", () => {
    writeFileSync(
      join(TMP, "config", "collaboration.json"),
      JSON.stringify({ mode: "github", team_repo_url: "https://github.com/org/repo" })
    );
    const result = readCollaboration(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.collab.mode).toBe("github");
  });

  it("returns ok:false reason:missing when file absent", () => {
    const result = readCollaboration(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });
});

// ── getActiveProfile ────────────────────────────────────────────────────────────
// Use opts to point at a temp file — avoids HOME env manipulation and module caching issues.

describe("getActiveProfile", () => {
  const FAKE_DRAFT = `/tmp/draft-core-active-profile-test-${Date.now()}`;

  beforeEach(() => mkdirSync(FAKE_DRAFT, { recursive: true }));
  afterEach(() => rmSync(FAKE_DRAFT, { recursive: true, force: true }));

  it("returns profile name from active-profile file", () => {
    const file = join(FAKE_DRAFT, "active-profile");
    writeFileSync(file, "acme\n");
    expect(getActiveProfile({ activeProfileFile: file })).toBe("acme");
  });

  it("returns 'default' when active-profile file is missing", () => {
    const file = join(FAKE_DRAFT, "active-profile"); // does not exist
    expect(getActiveProfile({ activeProfileFile: file })).toBe("default");
  });

  it("returns 'default' when active-profile file is whitespace-only", () => {
    const file = join(FAKE_DRAFT, "active-profile");
    writeFileSync(file, "   \n");
    expect(getActiveProfile({ activeProfileFile: file })).toBe("default");
  });
});

describe("workspace-scoped manifest paths", () => {
  const FAKE_ROOT = `/tmp/draft-core-manifest-paths-${Date.now()}`;
  const workspacesDir = join(FAKE_ROOT, "workspaces");
  const activeProfileFile = join(FAKE_ROOT, "active-profile");
  const opts = { workspacesDir, activeProfileFile };

  afterEach(() => rmSync(FAKE_ROOT, { recursive: true, force: true }));

  it("resolves manifest paths for an explicit profile", () => {
    expect(getSkillManifestPath("acme", opts))
      .toBe(join(workspacesDir, "acme", "config", "skill-manifest.json"));
    expect(getMcpManifestPath("acme", opts))
      .toBe(join(workspacesDir, "acme", "config", "mcp-manifest.json"));
  });

  it("resolves manifest paths for the active profile", () => {
    mkdirSync(FAKE_ROOT, { recursive: true });
    writeFileSync(activeProfileFile, "personal\n");

    expect(getSkillManifestPath(undefined, opts))
      .toBe(join(workspacesDir, "personal", "config", "skill-manifest.json"));
    expect(getMcpManifestPath(undefined, opts))
      .toBe(join(workspacesDir, "personal", "config", "mcp-manifest.json"));
  });
});

// ── getProfiles ─────────────────────────────────────────────────────────────────

describe("getProfiles", () => {
  const FAKE_ROOT      = `/tmp/draft-core-profiles-test-${Date.now()}`;
  const FAKE_WORKSPACES = join(FAKE_ROOT, "workspaces");
  const FAKE_AP_FILE   = join(FAKE_ROOT, "active-profile");

  afterEach(() => rmSync(FAKE_ROOT, { recursive: true, force: true }));

  const opts = () => ({ workspacesDir: FAKE_WORKSPACES, activeProfileFile: FAKE_AP_FILE });

  it("returns empty names list when workspaces dir does not exist", () => {
    mkdirSync(FAKE_ROOT, { recursive: true });
    const result = getProfiles(opts());
    expect(result.names).toEqual([]);
  });

  it("lists profile directories sorted alphabetically", () => {
    mkdirSync(join(FAKE_WORKSPACES, "zebra"), { recursive: true });
    mkdirSync(join(FAKE_WORKSPACES, "acme"),  { recursive: true });
    mkdirSync(join(FAKE_WORKSPACES, "myco"),  { recursive: true });
    const result = getProfiles(opts());
    expect(result.names).toEqual(["acme", "myco", "zebra"]);
  });

  it("excludes files — only directories are profiles", () => {
    mkdirSync(join(FAKE_WORKSPACES, "acme"), { recursive: true });
    writeFileSync(join(FAKE_WORKSPACES, "not-a-profile.txt"), "hello");
    const result = getProfiles(opts());
    expect(result.names).toEqual(["acme"]);
  });

  it("active field reflects the active-profile file", () => {
    mkdirSync(join(FAKE_WORKSPACES, "acme"),           { recursive: true });
    mkdirSync(join(FAKE_WORKSPACES, "draft-pm-agent"), { recursive: true });
    writeFileSync(FAKE_AP_FILE, "acme");
    const result = getProfiles(opts());
    expect(result.active).toBe("acme");
    expect(result.names).toContain("acme");
    expect(result.names).toContain("draft-pm-agent");
  });

  it("active defaults to 'default' when active-profile file is missing", () => {
    mkdirSync(join(FAKE_WORKSPACES, "acme"), { recursive: true });
    const result = getProfiles(opts()); // FAKE_AP_FILE does not exist
    expect(result.active).toBe("default");
  });
});

// ── setActiveProfile ───────────────────────────────────────────────────────────

describe("setActiveProfile", () => {
  const FAKE_ROOT       = `/tmp/draft-core-set-active-profile-test-${Date.now()}`;
  const FAKE_WORKSPACES = join(FAKE_ROOT, "workspaces");
  const FAKE_AP_FILE    = join(FAKE_ROOT, "active-profile");

  afterEach(() => rmSync(FAKE_ROOT, { recursive: true, force: true }));

  const opts = () => ({ workspacesDir: FAKE_WORKSPACES, activeProfileFile: FAKE_AP_FILE });

  it("writes active-profile when the profile exists", () => {
    mkdirSync(join(FAKE_WORKSPACES, "acme"), { recursive: true });
    const result = setActiveProfile("acme", opts());
    expect(result).toEqual({ ok: true, active: "acme" });
    expect(getActiveProfile(opts())).toBe("acme");
  });

  it("rejects missing profile directories", () => {
    mkdirSync(FAKE_WORKSPACES, { recursive: true });
    const result = setActiveProfile("ghost", opts());
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects invalid profile names", () => {
    mkdirSync(FAKE_WORKSPACES, { recursive: true });
    const result = setActiveProfile("../nope", opts());
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
