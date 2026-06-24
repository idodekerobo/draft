import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import {
  scanSkillDirectories,
  isDraftManaged,
  scanMCPConnections,
  createSymlinks,
  readSkillManifest,
  updateSkillManifest,
  type ScannedSkill,
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

    // Claude skill
    mkdirSync(join(claudeDir, "browse"), { recursive: true });
    writeFileSync(join(claudeDir, "browse", "SKILL.md"), "# Browse skill");

    // Codex skill
    mkdirSync(join(codexDir, "research"), { recursive: true });
    writeFileSync(join(codexDir, "research", "SKILL.md"), "# Research skill");

    const skills = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      manifestPath: join(TMP, "skill-manifest.json"),
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

  it("returns empty array for missing dirs", () => {
    const skills = scanSkillDirectories({
      claudeSkillsDir: join(TMP, "nonexistent-claude"),
      codexSkillsDir: join(TMP, "nonexistent-codex"),
      draftDir: join(TMP, "draft"),
    });
    expect(skills).toEqual([]);
  });

  it("returns empty array for empty dirs", () => {
    const claudeDir = join(TMP, "claude-skills-empty");
    const codexDir = join(TMP, "codex-skills-empty");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    const skills = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
      manifestPath: join(TMP, "skill-manifest.json"),
      draftDir: join(TMP, "draft"),
    });
    expect(skills).toEqual([]);
  });

  it("calculates token count correctly (content length / 4, ceiling)", () => {
    const claudeDir = join(TMP, "claude-tokens");
    mkdirSync(join(claudeDir, "myskill"), { recursive: true });
    // 10 chars → ceil(10/4) = 3
    writeFileSync(join(claudeDir, "myskill", "a.md"), "1234567890");
    // 7 chars → total 17 → ceil(17/4) = 5
    writeFileSync(join(claudeDir, "myskill", "b.md"), "1234567");

    const skills = scanSkillDirectories({
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(TMP, "no-codex"),
      draftDir: join(TMP, "draft"),
    });

    expect(skills.length).toBe(1);
    expect(skills[0].tokenCount).toBe(Math.ceil(17 / 4)); // 5
  });

  it("skips Draft-managed symlinks", () => {
    const claudeDir = join(TMP, "claude-skills-draft");
    const draftDir = join(TMP, "draft");

    // Real skill
    mkdirSync(join(claudeDir, "real-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "real-skill", "SKILL.md"), "# Real");

    // Draft-managed skill (symlink into draftDir)
    const draftSkillSource = join(draftDir, "skills", "draft-skill");
    mkdirSync(draftSkillSource, { recursive: true });
    writeFileSync(join(draftSkillSource, "SKILL.md"), "# Draft managed");
    symlinkSync(draftSkillSource, join(claudeDir, "draft-skill"));

    const skills = scanSkillDirectories({
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

    const connections = scanMCPConnections({ claudeConfigPath: configPath });
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
    });
    expect(connections).toEqual([]);
  });

  it("returns empty for malformed JSON", () => {
    const configPath = join(TMP, "bad.json");
    writeFileSync(configPath, "not valid json {{{");
    const connections = scanMCPConnections({ claudeConfigPath: configPath });
    expect(connections).toEqual([]);
  });

  it("returns empty when mcpServers key is missing", () => {
    const configPath = join(TMP, "no-mcp.json");
    writeFileSync(configPath, JSON.stringify({ someOtherKey: true }));
    const connections = scanMCPConnections({ claudeConfigPath: configPath });
    expect(connections).toEqual([]);
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

  it("skips when target already exists (idempotent)", () => {
    const claudeDir = join(TMP, "claude-idem");
    const codexDir = join(TMP, "codex-idem");

    const skillSource = join(TMP, "idem-source");
    mkdirSync(skillSource, { recursive: true });

    // Pre-create the target
    mkdirSync(join(codexDir, "my-skill"), { recursive: true });

    const skills: ScannedSkill[] = [
      {
        name: "my-skill",
        agent: "claude-code",
        dirPath: skillSource,
        files: [],
        tokenCount: 0,
      },
    ];

    const result = createSymlinks(skills, {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: codexDir,
    });

    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toBe(join(codexDir, "my-skill"));
    expect(result.errors).toEqual([]);
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
        tokenCount: 0,
      },
    ], {
      claudeSkillsDir: claudeDir,
      codexSkillsDir: join(invalidCodexParent, "skills"),
      manifestPath: join(TMP, "skill-manifest.json"),
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("my-skill");
  });
});

// ── skill manifest ────────────────────────────────────────────────────────────

describe("skill manifest", () => {
  it("merges and deduplicates Draft-created symlink paths", () => {
    const manifestPath = join(TMP, "skill-manifest.json");
    updateSkillManifest(["/tmp/codex/a"], manifestPath);
    updateSkillManifest(["/tmp/codex/a", "/tmp/claude/b"], manifestPath);
    expect(readSkillManifest(manifestPath)).toEqual(["/tmp/codex/a", "/tmp/claude/b"]);
  });

  it("returns an empty manifest when the file is absent or malformed", () => {
    const manifestPath = join(TMP, "missing.json");
    expect(readSkillManifest(manifestPath)).toEqual([]);
    writeFileSync(manifestPath, "not json");
    expect(readSkillManifest(manifestPath)).toEqual([]);
  });
});
