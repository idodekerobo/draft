import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import {
  scanSkillDirectories,
  scanAll,
  isDraftManaged,
  scanMCPConnections,
  createSymlinks,
  readSkillManifest,
  writeSkillManifest,
  hashSkillDir,
  detectPending,
  reconcileSkillManifest,
  type ScannedSkill,
  type SkillManifest,
} from "../scanner";

const TMP = `/tmp/draft-core-scanner-${Date.now()}`;

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// ── scanSkillDirectories ───────────────────────────────────────────────────────

describe("scanSkillDirectories", () => {
  it("finds skills in mock dirs with correct agent attribution", () => {
    const claudeDir = join(TMP, "claude-skills");
    const codexDir = join(TMP, "codex-skills");
    const draftDir = join(TMP, "draft");

    mkdirSync(join(claudeDir, "browse"), { recursive: true });
    writeFileSync(join(claudeDir, "browse", "SKILL.md"), "# Browse skill");

    mkdirSync(join(codexDir, "research"), { recursive: true });
    writeFileSync(join(codexDir, "research", "SKILL.md"), "# Research skill");

    const { skills } = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir,
    });

    expect(skills.length).toBe(2);

    const browse = skills.find((s) => s.name === "browse");
    expect(browse).toBeDefined();
    expect(browse!.agent).toBe("claude-code");
    expect(browse!.files).toContain("SKILL.md");

    const research = skills.find((s) => s.name === "research");
    expect(research).toBeDefined();
    expect(research!.agent).toBe("codex");
  });

  it("returns empty for missing dirs", () => {
    const { skills, errors } = scanSkillDirectories({
      claudeSkillsDir: join(TMP, "nonexistent-claude"),
      codexSkillsDir: join(TMP, "nonexistent-codex"),
      draftDir: join(TMP, "draft"),
    });
    expect(skills).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("returns empty for empty dirs", () => {
    const claudeDir = join(TMP, "claude-skills-empty");
    const codexDir = join(TMP, "codex-skills-empty");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    const { skills } = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
    });
    expect(skills).toEqual([]);
  });

  it("calculates token count correctly (content length / 4, ceiling)", () => {
    const claudeDir = join(TMP, "claude-tokens");
    mkdirSync(join(claudeDir, "myskill"), { recursive: true });
    writeFileSync(join(claudeDir, "myskill", "SKILL.md"), "1234567890abcdefg");

    const { skills } = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(TMP, "no-codex"),
      draftDir: join(TMP, "draft"),
    });

    expect(skills.length).toBe(1);
    expect(skills[0].tokenCount).toBe(Math.ceil(17 / 4));
  });

  it("skips Draft-managed symlinks", () => {
    const claudeDir = join(TMP, "claude-skills-draft");
    const draftDir = join(TMP, "draft");

    mkdirSync(join(claudeDir, "real-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "real-skill", "SKILL.md"), "# Real");

    const draftSkillSource = join(draftDir, "skills", "draft-skill");
    mkdirSync(draftSkillSource, { recursive: true });
    writeFileSync(join(draftSkillSource, "SKILL.md"), "# Draft managed");
    symlinkSync(draftSkillSource, join(claudeDir, "draft-skill"));

    const { skills } = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(TMP, "no-codex"),
      draftDir,
    });

    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("real-skill");
  });
});

// ── isDraftManaged ─────────────────────────────────────────────────────────────

describe("isDraftManaged", () => {
  it("returns true for symlinks pointing into a mock draft dir", () => {
    const draftDir = join(TMP, "draft-managed");
    const skillSource = join(draftDir, "skills", "my-skill");
    mkdirSync(skillSource, { recursive: true });

    const linkPath = join(TMP, "link-to-draft");
    symlinkSync(skillSource, linkPath);

    expect(isDraftManaged(linkPath, draftDir)).toBe(true);
  });

  it("returns false for regular directories", () => {
    const regularDir = join(TMP, "regular-dir");
    mkdirSync(regularDir, { recursive: true });

    expect(isDraftManaged(regularDir, join(TMP, "draft"))).toBe(false);
  });

  it("returns false for symlinks pointing outside draft dir", () => {
    const otherDir = join(TMP, "other");
    mkdirSync(otherDir, { recursive: true });

    const linkPath = join(TMP, "link-to-other");
    symlinkSync(otherDir, linkPath);

    expect(isDraftManaged(linkPath, join(TMP, "draft"))).toBe(false);
  });

  it("returns false for nonexistent paths", () => {
    expect(isDraftManaged(join(TMP, "does-not-exist"), join(TMP, "draft"))).toBe(false);
  });
});

// ── scanMCPConnections ─────────────────────────────────────────────────────────

describe("scanMCPConnections", () => {
  it("parses a mock .claude.json with mcpServers", () => {
    const configPath = join(TMP, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "my-server": { command: "node", args: ["server.js"] },
          "another-server": { command: "python", args: ["serve.py"] },
        },
      })
    );

    const connections = scanMCPConnections({
      claudeConfigPath: configPath,
      codexConfigPath: join(TMP, "nonexistent-codex.toml"),
    });
    expect(connections.length).toBe(2);

    const myServer = connections.find((c) => c.name === "my-server");
    expect(myServer).toBeDefined();
    expect(myServer!.agent).toBe("claude-code");
    expect(myServer!.config.command).toBe("node");

    const another = connections.find((c) => c.name === "another-server");
    expect(another).toBeDefined();
    expect(another!.config.command).toBe("python");
  });

  it("returns empty for missing file", () => {
    const connections = scanMCPConnections({
      claudeConfigPath: join(TMP, "nonexistent.json"),
      codexConfigPath: join(TMP, "nonexistent-codex.toml"),
    });
    expect(connections).toEqual([]);
  });

  it("returns empty for malformed JSON", () => {
    const configPath = join(TMP, "bad.json");
    writeFileSync(configPath, "not valid json {{{");
    const connections = scanMCPConnections({
      claudeConfigPath: configPath,
      codexConfigPath: join(TMP, "nonexistent-codex.toml"),
    });
    expect(connections).toEqual([]);
  });

  it("returns empty when mcpServers key is missing", () => {
    const configPath = join(TMP, "no-mcp.json");
    writeFileSync(configPath, JSON.stringify({ someOtherKey: true }));
    const connections = scanMCPConnections({
      claudeConfigPath: configPath,
      codexConfigPath: join(TMP, "nonexistent-codex.toml"),
    });
    expect(connections).toEqual([]);
  });

  it("parses Codex config.toml with mcp_servers sections", () => {
    const codexConfig = join(TMP, "config.toml");
    writeFileSync(codexConfig, `
model = "gpt-5.5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
enabled = true

[mcp_servers.context7.env]
MY_VAR = "my_value"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
startup_timeout_sec = 20

[projects."/some/path"]
trust_level = "trusted"
`);

    const connections = scanMCPConnections({
      claudeConfigPath: join(TMP, "nonexistent.json"),
      codexConfigPath: codexConfig,
    });

    expect(connections.length).toBe(2);

    const ctx7 = connections.find((c) => c.name === "context7");
    expect(ctx7).toBeDefined();
    expect(ctx7!.agent).toBe("codex");
    expect(ctx7!.config.command).toBe("npx");
    expect(ctx7!.config.args).toEqual(["-y", "@upstash/context7-mcp"]);
    expect(ctx7!.config.enabled).toBe(true);
    expect(ctx7!.config.env).toEqual({ MY_VAR: "my_value" });

    const figma = connections.find((c) => c.name === "figma");
    expect(figma).toBeDefined();
    expect(figma!.agent).toBe("codex");
    expect(figma!.config.url).toBe("https://mcp.figma.com/mcp");
    expect(figma!.config.startup_timeout_sec).toBe(20);
  });

  it("combines Claude and Codex MCP servers", () => {
    const claudeConfig = join(TMP, "claude-combined.json");
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { "my-server": { command: "node" } } }));

    const codexConfig = join(TMP, "codex-combined.toml");
    writeFileSync(codexConfig, `[mcp_servers.codex-server]\ncommand = "python"\n`);

    const connections = scanMCPConnections({ claudeConfigPath: claudeConfig, codexConfigPath: codexConfig });
    expect(connections.length).toBe(2);
    expect(connections.find((c) => c.agent === "claude-code")).toBeDefined();
    expect(connections.find((c) => c.agent === "codex")).toBeDefined();
  });

  it("handles inline tables in Codex config", () => {
    const codexConfig = join(TMP, "codex-inline.toml");
    writeFileSync(codexConfig, `[mcp_servers.chrome]\nurl = "http://localhost:3000/mcp"\nhttp_headers = { "X-Region" = "us-east-1" }\n`);

    const connections = scanMCPConnections({
      claudeConfigPath: join(TMP, "nonexistent.json"),
      codexConfigPath: codexConfig,
    });

    expect(connections.length).toBe(1);
    expect(connections[0].config.http_headers).toEqual({ "X-Region": "us-east-1" });
  });
});

// ── scanAll ───────────────────────────────────────────────────────────────────

describe("scanAll", () => {
  it("returns skills, MCP servers, and errors in one call", () => {
    const claudeDir = join(TMP, "all-claude-skills");
    mkdirSync(join(claudeDir, "browse"), { recursive: true });
    writeFileSync(join(claudeDir, "browse", "SKILL.md"), "# Browse");

    const claudeConfig = join(TMP, "all-claude.json");
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { "srv": { command: "node" } } }));

    const result = scanAll({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(TMP, "no-codex"),
      draftDir: join(TMP, "draft"),
      claudeConfigPath: claudeConfig,
      codexConfigPath: join(TMP, "no-codex-config.toml"),
    });

    expect(result.skills.length).toBe(1);
    expect(result.mcpServers.length).toBe(1);
    expect(result.errors).toEqual([]);
  });
});

// ── createSymlinks ─────────────────────────────────────────────────────────────

describe("createSymlinks", () => {
  it("creates valid symlinks in the cross-agent directory", () => {
    const claudeDir = join(TMP, "claude-link");
    const codexDir = join(TMP, "codex-link");

    // Create a source skill directory
    const skillSource = join(TMP, "source-skill");
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(join(skillSource, "SKILL.md"), "# Source");

    const skills: ScannedSkill[] = [
      {
        name: "my-skill",
        agent: "claude-code",
        dirPath: skillSource,
        files: ["SKILL.md"],
        description: "",
        descriptionTokenCount: 0,
        tokenCount: 3,
      },
    ];

    const result = createSymlinks(skills, {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      manifestPath: join(TMP, "skill-manifest.json"),
    });

    expect(result.created.length).toBe(1);
    expect(result.created[0]).toBe(join(codexDir, "my-skill"));
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("symlinks codex skills into claude dir", () => {
    const claudeDir = join(TMP, "claude-link2");
    const codexDir = join(TMP, "codex-link2");

    const skillSource = join(TMP, "codex-source");
    mkdirSync(skillSource, { recursive: true });

    const skills: ScannedSkill[] = [
      {
        name: "codex-skill",
        agent: "codex",
        dirPath: skillSource,
        files: [],
        description: "",
        descriptionTokenCount: 0,
        tokenCount: 0,
      },
    ];

    const result = createSymlinks(skills, {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
    });

    expect(result.created.length).toBe(1);
    expect(result.created[0]).toBe(join(claudeDir, "codex-skill"));
  });

  it("records approval in an empty profile manifest when a correct symlink already exists", () => {
    const claudeDir = join(TMP, "claude-idem");
    const codexDir = join(TMP, "codex-idem");

    const skillSource = join(TMP, "idem-source");
    mkdirSync(skillSource, { recursive: true });

    // Pre-create the target as a symlink pointing to the same source
    mkdirSync(codexDir, { recursive: true });
    symlinkSync(resolve(skillSource), join(codexDir, "my-skill"));

    const skills: ScannedSkill[] = [
      {
        name: "my-skill",
        agent: "claude-code",
        dirPath: skillSource,
        files: [],
        description: "",
        descriptionTokenCount: 0,
        tokenCount: 0,
      },
    ];

    const manifestPath = join(TMP, "profiles", "acme", "config", "skill-manifest.json");
    const result = createSymlinks(skills, {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      manifestPath,
    });

    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toBe(join(codexDir, "my-skill"));
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);

    const manifest = readSkillManifest(manifestPath);
    expect(manifest.schema_version).toBe(5);
    expect(manifest.skills["claude-code:my-skill"]).toMatchObject({
      id: "claude-code:my-skill",
      name: "my-skill",
      kind: "personal",
      status: "approved",
      removed_at: null,
    });
    expect(manifest.skills["claude-code:my-skill"].synced_to.codex?.symlink_path)
      .toBe(join(codexDir, "my-skill"));
  });

  it("surfaces a conflict when a real directory already exists at the target", () => {
    const claudeDir = join(TMP, "claude-conflict");
    const codexDir = join(TMP, "codex-conflict");

    const skillSource = join(TMP, "conflict-source");
    mkdirSync(skillSource, { recursive: true });

    // Pre-create the target as a real directory (not a symlink)
    mkdirSync(join(codexDir, "my-skill"), { recursive: true });

    const skills: ScannedSkill[] = [
      {
        name: "my-skill",
        agent: "claude-code",
        dirPath: skillSource,
        files: [],
        description: "",
        descriptionTokenCount: 0,
        tokenCount: 0,
      },
    ];

    const result = createSymlinks(skills, {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      manifestPath: join(TMP, "skill-manifest-conflict.json"),
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].linkPath).toBe(join(codexDir, "my-skill"));
    expect(result.conflicts[0].actual).toBeNull(); // real dir, not a symlink
  });

  it("reports errors when it cannot create the destination directory", () => {
    const claudeDir = join(TMP, "claude-error");
    const invalidCodexParent = join(TMP, "not-a-directory");
    const skillSource = join(TMP, "error-source");
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(invalidCodexParent, "file prevents nested directory creation");

    const result = createSymlinks([
      {
        name: "my-skill",
        agent: "claude-code",
        dirPath: skillSource,
        files: [],
        description: "",
        descriptionTokenCount: 0,
        tokenCount: 0,
      },
    ], {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(invalidCodexParent, "skills"),
      manifestPath: join(TMP, "skill-manifest-error.json"),
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("my-skill");
  });
});

// ── skill manifest ────────────────────────────────────────────────────────────

describe("skill manifest", () => {
  it("returns an empty manifest when the file is absent or malformed", () => {
    expect(readSkillManifest(join(TMP, "missing.json"))).toEqual({ version: 5, schema_version: 5, min_reader_version: 1, skills: {}, name_conflicts: {} });
    writeFileSync(join(TMP, "bad.json"), "not json");
    expect(readSkillManifest(join(TMP, "bad.json"))).toEqual({ version: 5, schema_version: 5, min_reader_version: 1, skills: {}, name_conflicts: {} });
  });

  it("treats a stale v4 manifest at a workspace-scoped path as empty", () => {
    const manifestPath = join(TMP, "workspaces", "acme", "config", "skill-manifest.json");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      version: 4,
      schema_version: 4,
      min_reader_version: 1,
      skills: {
        "claude-code:browse": {
          id: "claude-code:browse",
          name: "browse",
        },
      },
      name_conflicts: {},
    }));

    expect(readSkillManifest(manifestPath)).toEqual({
      version: 5,
      schema_version: 5,
      min_reader_version: 1,
      skills: {},
      name_conflicts: {},
    });
  });

  it("round-trips a manifest through writeSkillManifest and readSkillManifest", () => {
    const manifestPath = join(TMP, "skill-manifest.json");
    const manifest: SkillManifest = {
      version: 5, schema_version: 5, min_reader_version: 1,
      skills: {
        "claude-code:browse": {
          id: "claude-code:browse", name: "browse", source_agent: "claude-code",
          source_path: "/fake/browse", skill_dir_hash: "sha256:abc",
          added_at: "2026-01-01T00:00:00.000Z", approved_at: "2026-01-01T00:00:00.000Z",
          status: "approved", synced_to: { codex: { target_name: "browse", symlink_path: "/fake/codex/browse", synced_at: "2026-01-01T00:00:00.000Z" } },
          removed_at: null, kind: "personal",
        },
      },
      name_conflicts: {},
    };
    writeSkillManifest(manifest, manifestPath);
    expect(readSkillManifest(manifestPath)).toEqual(manifest);
  });
});

// ── hashSkillDir ──────────────────────────────────────────────────────────────

describe("hashSkillDir", () => {
  it("returns a sha256: prefixed string for a directory with files", () => {
    const dir = join(TMP, "hash-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# Test skill");

    const hash = hashSkillDir(dir);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("returns sha256:empty for an empty directory", () => {
    const dir = join(TMP, "empty-hash-dir");
    mkdirSync(dir, { recursive: true });
    expect(hashSkillDir(dir)).toBe("sha256:empty");
  });

  it("returns sha256:empty for a nonexistent directory", () => {
    expect(hashSkillDir(join(TMP, "does-not-exist"))).toBe("sha256:empty");
  });

  it("produces different hashes for directories with different content", () => {
    const dir1 = join(TMP, "hash-dir1");
    const dir2 = join(TMP, "hash-dir2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, "SKILL.md"), "# Skill A");
    writeFileSync(join(dir2, "SKILL.md"), "# Skill B");

    expect(hashSkillDir(dir1)).not.toBe(hashSkillDir(dir2));
  });

  it("produces the same hash for directories with identical content", () => {
    const dir1 = join(TMP, "hash-same1");
    const dir2 = join(TMP, "hash-same2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, "SKILL.md"), "# Identical");
    writeFileSync(join(dir2, "SKILL.md"), "# Identical");

    expect(hashSkillDir(dir1)).toBe(hashSkillDir(dir2));
  });
});

// ── detectPending ─────────────────────────────────────────────────────────────

describe("detectPending", () => {
  it("returns a pending entry for a new real-directory skill not in manifest", () => {
    const claudeDir = join(TMP, "pending-claude");
    const codexDir = join(TMP, "pending-codex");
    const manifestPath = join(TMP, "pending-manifest.json");

    mkdirSync(join(claudeDir, "my-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "my-skill", "SKILL.md"), "# My skill");

    const { pending, conflicts } = detectPending({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe("my-skill");
    expect(pending[0].source_agent).toBe("claude-code");
    expect(conflicts).toEqual([]);
  });

  it("returns a conflict when both agents have a real directory with the same name", () => {
    const claudeDir = join(TMP, "conflict-claude");
    const codexDir = join(TMP, "conflict-codex");
    const manifestPath = join(TMP, "conflict-manifest.json");

    mkdirSync(join(claudeDir, "shared-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "shared-skill", "SKILL.md"), "# Claude version");

    mkdirSync(join(codexDir, "shared-skill"), { recursive: true });
    writeFileSync(join(codexDir, "shared-skill", "SKILL.md"), "# Codex version");

    const { pending, conflicts } = detectPending({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].name).toBe("shared-skill");
    expect(pending).toEqual([]);
  });

  it("skips skills already present in the v5 manifest", () => {
    const claudeDir = join(TMP, "tracked-claude");
    const codexDir = join(TMP, "tracked-codex");
    const manifestPath = join(TMP, "tracked-manifest.json");

    const skillDir = join(claudeDir, "tracked-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Tracked");

    // Write a v5 manifest that already tracks this skill
    const manifest = {
      version: 5,
      schema_version: 5,
      min_reader_version: 1,
      skills: {
        "claude-code:tracked-skill": {
          id: "claude-code:tracked-skill",
          name: "tracked-skill",
          source_agent: "claude-code",
          source_path: skillDir,
          skill_dir_hash: "sha256:abc",
          added_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          status: "approved",
          synced_to: {},
          removed_at: null,
          kind: "personal",
        },
      },
      name_conflicts: {},
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const { pending, conflicts } = detectPending({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    expect(pending).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("ignores symlinks (only flags real directories as pending)", () => {
    const claudeDir = join(TMP, "sym-claude");
    const codexDir = join(TMP, "sym-codex");
    const manifestPath = join(TMP, "sym-manifest.json");

    const realSkill = join(TMP, "real-skill-source");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "# Real");

    // Create a symlink in claude skills (not a real dir)
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(resolve(realSkill), join(claudeDir, "sym-skill"));

    const { pending, conflicts } = detectPending({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    // Symlinks should not be flagged as pending
    expect(pending).toEqual([]);
    expect(conflicts).toEqual([]);
  });
});

// ── reconcileSkillManifest ────────────────────────────────────────────────────

describe("reconcileSkillManifest", () => {
  it("repairs a missing symlink when the source still exists", () => {
    const claudeDir = join(TMP, "reconcile-claude");
    const codexDir = join(TMP, "reconcile-codex");
    const manifestPath = join(TMP, "reconcile-manifest.json");

    const skillDir = join(claudeDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# My skill");
    mkdirSync(codexDir, { recursive: true });

    const expectedSymlink = join(codexDir, "my-skill");
    const manifest = {
      version: 5,
      schema_version: 5,
      min_reader_version: 1,
      skills: {
        "claude-code:my-skill": {
          id: "claude-code:my-skill",
          name: "my-skill",
          source_agent: "claude-code",
          source_path: skillDir,
          skill_dir_hash: "sha256:abc",
          added_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          status: "approved",
          kind: "personal",
          synced_to: {
            codex: {
              target_name: "my-skill",
              symlink_path: expectedSymlink,
              synced_at: new Date().toISOString(),
            },
          },
          removed_at: null,
        },
      },
      name_conflicts: {},
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = reconcileSkillManifest({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    expect(result.repaired).toContain(expectedSymlink);
    expect(result.tombstoned).toEqual([]);
  });

  it("tombstones an entry when both source and symlink are gone", () => {
    const claudeDir = join(TMP, "tombstone-claude");
    const codexDir = join(TMP, "tombstone-codex");
    const manifestPath = join(TMP, "tombstone-manifest.json");

    // Neither source nor symlink exist on disk
    const manifest = {
      version: 5,
      schema_version: 5,
      min_reader_version: 1,
      skills: {
        "claude-code:gone-skill": {
          id: "claude-code:gone-skill",
          name: "gone-skill",
          source_agent: "claude-code",
          source_path: join(claudeDir, "gone-skill"),
          skill_dir_hash: "sha256:abc",
          added_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          status: "approved",
          synced_to: {
            codex: {
              target_name: "gone-skill",
              symlink_path: join(codexDir, "gone-skill"),
              synced_at: new Date().toISOString(),
            },
          },
          removed_at: null,
          kind: "personal",
        },
      },
      name_conflicts: {},
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = reconcileSkillManifest({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      draftDir: join(TMP, "draft"),
      manifestPath,
    });

    expect(result.tombstoned).toContain("claude-code:gone-skill");
    expect(result.repaired).toEqual([]);

    // Manifest should reflect the tombstone
    const updated = JSON.parse(readFileSync(manifestPath, "utf8") as string);
    expect(updated.skills["claude-code:gone-skill"].removed_at).not.toBeNull();
  });
});
