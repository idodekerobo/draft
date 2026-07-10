import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  installProfileAssets,
  isProfileSwitchLockHeld,
  switchProfileAssets,
  TeamAssetValidationError,
  uninstallProfileAssets,
  validateProfileAssets,
  type TeamAssetPaths,
} from "../sync/team-assets";
import { readMcpManifest } from "../sync/manifest";
import { readAgentMcps } from "../agents/mcp";

const TMP = join("/tmp", `draft-team-assets-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function paths(): TeamAssetPaths {
  const workspacePath = join(TMP, "workspace");
  return {
    workspacesDir: join(TMP, "workspaces"),
    activeProfileFile: join(TMP, "active-profile"),
    workspacePath,
    claudeSkillsDir: join(TMP, "claude", "skills"),
    codexSkillsDir: join(TMP, "codex", "skills"),
    claudeConfigPath: join(TMP, "claude.json"),
    codexConfigPath: join(TMP, "codex", "config.toml"),
    skillManifestPath: join(workspacePath, "config", "skill-manifest.json"),
    mcpManifestPath: join(workspacePath, "config", "mcp-manifest.json"),
    statePath: join(workspacePath, "config"),
    envStatePath: join(TMP, "state"),
  };
}

function createSkill(name: string, withSkillFile = true): string {
  const skill = join(paths().workspacePath, "skills", name);
  mkdirSync(skill, { recursive: true });
  if (withSkillFile) writeFileSync(join(skill, "SKILL.md"), `# ${name}\n`);
  return skill;
}

function createMcpManifest(): void {
  mkdirSync(join(paths().workspacePath, "config"), { recursive: true });
  writeFileSync(join(paths().workspacePath, "config", "mcp.json"), JSON.stringify({
    version: 1,
    servers: [{
      name: "linear",
      canonical: {
        type: "http",
        url: "https://mcp.example.com",
        headers: {
          Authorization: { value_env: "DRAFT_MCP_LINEAR_TOKEN", secret: true },
        },
      },
      required_secrets: ["DRAFT_MCP_LINEAR_TOKEN"],
    }],
  }));
}

describe("profile team asset lifecycle", () => {
  it("validates SKILL.md before mutating targets", async () => {
    createSkill("broken", false);
    expect(validateProfileAssets("acme", paths()).ok).toBe(false);
    await expect(installProfileAssets("acme", paths())).rejects.toBeInstanceOf(TeamAssetValidationError);
    expect(existsSync(join(paths().claudeSkillsDir, "broken"))).toBe(false);
  });

  it("blocks both skill targets when either target has a personal collision", async () => {
    createSkill("review");
    mkdirSync(join(paths().claudeSkillsDir, "review"), { recursive: true });
    writeFileSync(join(paths().claudeSkillsDir, "review", "SKILL.md"), "# personal\n");

    const result = await installProfileAssets("acme", paths());

    expect(result.conflicts).toContainEqual({
      kind: "skill",
      name: "review",
      profile: "acme",
      reason: "personal-name-collision",
    });
    expect(existsSync(join(paths().codexSkillsDir, "review"))).toBe(false);
    expect(lstatSync(join(paths().claudeSkillsDir, "review")).isDirectory()).toBe(true);
  });

  it("only removes symlinks still owned by the team entry", async () => {
    const source = createSkill("review");
    await installProfileAssets("acme", paths());
    const claudeTarget = join(paths().claudeSkillsDir, "review");
    const codexTarget = join(paths().codexSkillsDir, "review");
    expect(resolve(join(claudeTarget, ".."), readlinkSync(claudeTarget))).toBe(resolve(source));

    unlinkSync(codexTarget);
    mkdirSync(codexTarget, { recursive: true });
    writeFileSync(join(codexTarget, "SKILL.md"), "# replacement\n");

    const result = await uninstallProfileAssets("acme", paths());
    expect(existsSync(claudeTarget)).toBe(false);
    expect(lstatSync(codexTarget).isDirectory()).toBe(true);
    expect(result.conflicts).toContainEqual({
      kind: "skill",
      name: "review",
      profile: "acme",
      reason: "target-modified",
    });
  });

  it("keeps MCPs pending when profile credentials are missing", async () => {
    createMcpManifest();
    const result = await installProfileAssets("acme", paths());
    expect(result.missingSecrets).toEqual([{
      name: "linear",
      requiredSecrets: ["DRAFT_MCP_LINEAR_TOKEN"],
    }]);
    expect(existsSync(paths().claudeConfigPath)).toBe(false);
    expect(existsSync(paths().codexConfigPath)).toBe(false);
    expect(readMcpManifest(paths().mcpManifestPath).mcps["team:linear"]?.install_state)
      .toBe("pending-secrets");
  });

  it("does not overwrite either MCP target when a personal name collides", async () => {
    createMcpManifest();
    writeFileSync(join(paths().workspacePath, "config", "secrets.json"), JSON.stringify({
      DRAFT_MCP_LINEAR_TOKEN: "team-token",
    }));
    writeFileSync(paths().claudeConfigPath, JSON.stringify({
      mcpServers: { linear: { url: "https://personal.example.com" } },
    }));

    const result = await installProfileAssets("acme", paths());
    expect(result.conflicts).toContainEqual({
      kind: "mcp",
      name: "linear",
      profile: "acme",
      reason: "personal-name-collision",
    });
    expect(existsSync(paths().codexConfigPath)).toBe(false);
  });

  it("preserves a modified MCP target during uninstall", async () => {
    createMcpManifest();
    writeFileSync(join(paths().workspacePath, "config", "secrets.json"), JSON.stringify({
      DRAFT_MCP_LINEAR_TOKEN: "team-token",
    }));
    await installProfileAssets("acme", paths());
    writeFileSync(paths().claudeConfigPath, JSON.stringify({
      mcpServers: { linear: { url: "https://personal.example.com" } },
    }));

    const result = await uninstallProfileAssets("acme", paths());

    expect(readAgentMcps("claude-code", paths().claudeConfigPath).linear?.url)
      .toBe("https://personal.example.com");
    expect(readAgentMcps("codex", paths().codexConfigPath).linear).toBeUndefined();
    expect(result.conflicts).toContainEqual({
      kind: "mcp",
      name: "linear",
      profile: "acme",
      reason: "target-modified",
    });
  });

  it("switches profile-owned skill sets without touching profile state directly", async () => {
    const common = paths();
    const lifecyclePaths: Partial<TeamAssetPaths> = {
      workspacesDir: common.workspacesDir,
      activeProfileFile: common.activeProfileFile,
      claudeSkillsDir: common.claudeSkillsDir,
      codexSkillsDir: common.codexSkillsDir,
      claudeConfigPath: common.claudeConfigPath,
      codexConfigPath: common.codexConfigPath,
      envStatePath: common.envStatePath,
    };
    for (const [profile, skill] of [["acme", "review"], ["personal", "notes"]] as const) {
      const dir = join(common.workspacesDir, profile, "skills", skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${skill}\n`);
    }
    writeFileSync(common.activeProfileFile, "acme\n");
    await installProfileAssets("acme", lifecyclePaths);

    const result = await switchProfileAssets("acme", "personal", lifecyclePaths);

    expect(existsSync(join(common.claudeSkillsDir, "review"))).toBe(false);
    expect(existsSync(join(common.codexSkillsDir, "review"))).toBe(false);
    expect(lstatSync(join(common.claudeSkillsDir, "notes")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(common.codexSkillsDir, "notes")).isSymbolicLink()).toBe(true);
    expect(readFileSync(common.activeProfileFile, "utf8").trim()).toBe("personal");
    expect(result.removedSkills).toContain("review");
    expect(result.installedSkills).toContain("notes");

    const acmeManifestPath = join(common.workspacesDir, "acme", "config", "skill-manifest.json");
    const personalManifestPath = join(common.workspacesDir, "personal", "config", "skill-manifest.json");
    expect(acmeManifestPath).not.toBe(personalManifestPath);
    expect(JSON.parse(readFileSync(acmeManifestPath, "utf8")).skills["team:review"].removed_at)
      .not.toBeNull();
    expect(JSON.parse(readFileSync(personalManifestPath, "utf8")).skills["team:notes"].removed_at)
      .toBeNull();
  });

});

describe("isProfileSwitchLockHeld", () => {
  const lockPath = join("/tmp", `draft-profile-switch-lock-test-${process.pid}`);
  afterEach(() => rmSync(lockPath, { recursive: true, force: true }));

  it("is false when no lock directory exists", () => {
    expect(isProfileSwitchLockHeld(lockPath)).toBe(false);
  });

  it("is true when a live process holds a fresh lock", () => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
    expect(isProfileSwitchLockHeld(lockPath)).toBe(true);
  });

  it("is false once the lock is released", () => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
    rmSync(lockPath, { recursive: true, force: true });
    expect(isProfileSwitchLockHeld(lockPath)).toBe(false);
  });

  it("is false when the recorded owner pid is no longer alive", () => {
    mkdirSync(lockPath, { recursive: true });
    // PID 999999 is very unlikely to be a live process.
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999 }));
    expect(isProfileSwitchLockHeld(lockPath)).toBe(false);
  });
});
