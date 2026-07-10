import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  installProfileAssets,
  isProfileSwitchLockHeld,
  releaseProfileSwitchLock,
  switchProfileAssets,
  TeamAssetValidationError,
  uninstallProfileAssets,
  validateProfileAssets,
  withProfileSwitchLock,
  type TeamAssetPaths,
} from "../sync/team-assets";
import { readMcpManifest, type CanonicalMcp } from "../sync/manifest";
import { readAgentMcps } from "../agents/mcp";
import { installPersonalMcps } from "../sync/mcp-sync";
import { installPersonalSkills, readSkillManifest } from "../scanner";

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

  it("uninstallProfileAssets only reports approved personal entries in removedSkills, not pending/conflict ones", async () => {
    const common = paths();
    const manifestPath = common.skillManifestPath;
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify({
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:approved-skill": {
          id: "claude-code:approved-skill", name: "approved-skill", source_agent: "claude-code",
          source_path: join(common.claudeSkillsDir, "approved-skill"), skill_dir_hash: "sha256:test",
          added_at: now, approved_at: now, status: "approved", synced_to: {}, removed_at: null, kind: "personal",
        },
        "claude-code:pending-skill": {
          id: "claude-code:pending-skill", name: "pending-skill", source_agent: "claude-code",
          source_path: join(common.claudeSkillsDir, "pending-skill"), skill_dir_hash: "sha256:test",
          added_at: now, approved_at: null, status: "pending", synced_to: {}, removed_at: null, kind: "personal",
        },
        "claude-code:conflict-skill": {
          id: "claude-code:conflict-skill", name: "conflict-skill", source_agent: "claude-code",
          source_path: join(common.claudeSkillsDir, "conflict-skill"), skill_dir_hash: "sha256:test",
          added_at: now, approved_at: now, status: "conflict", synced_to: {}, removed_at: null, kind: "personal",
        },
      },
    }));

    const result = await uninstallProfileAssets("acme", common);

    expect(result.removedSkills).toEqual(["approved-skill"]);
  });
});

describe("personal skill profile-switch lifecycle", () => {
  it("switch A -> B -> A deactivates/reinstalls each profile's personal skills, never tombstoning", async () => {
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
    mkdirSync(join(common.activeProfileFile, ".."), { recursive: true });
    writeFileSync(common.activeProfileFile, "acme\n");

    const sourceA = join(common.workspacesDir, "acme", "personal-skills", "a-skill");
    const sourceB = join(common.workspacesDir, "personal", "personal-skills", "b-skill");
    mkdirSync(sourceA, { recursive: true });
    mkdirSync(sourceB, { recursive: true });

    const acmeManifestPath = join(common.workspacesDir, "acme", "config", "skill-manifest.json");
    const personalManifestPath = join(common.workspacesDir, "personal", "config", "skill-manifest.json");

    // Seed acme's approval and let it install live (acme is the active profile).
    installPersonalSkills([{ name: "a-skill", agent: "claude-code", sourcePath: sourceA }], "acme", {
      claudeSkillsDir: common.claudeSkillsDir, codexSkillsDir: common.codexSkillsDir, manifestPath: acmeManifestPath,
    });
    // Seed "personal" profile's approval too, but it isn't active yet, so its
    // mirror is not live on disk — matches how a real inactive profile's
    // manifest looks (approved, but currently unlinked).
    installPersonalSkills([{ name: "b-skill", agent: "claude-code", sourcePath: sourceB }], "personal", {
      claudeSkillsDir: join(common.workspacesDir, "unused-claude"),
      codexSkillsDir: join(common.workspacesDir, "unused-codex"),
      manifestPath: personalManifestPath,
    });

    expect(lstatSync(join(common.codexSkillsDir, "a-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(common.codexSkillsDir, "b-skill"))).toBe(false);

    const switched = await switchProfileAssets("acme", "personal", lifecyclePaths);

    expect(existsSync(join(common.codexSkillsDir, "a-skill"))).toBe(false);
    expect(lstatSync(join(common.codexSkillsDir, "b-skill")).isSymbolicLink()).toBe(true);
    expect(switched.installedSkills).toContain("b-skill");
    expect(switched.removedSkills).toContain("a-skill");

    const acmeEntry = JSON.parse(readFileSync(acmeManifestPath, "utf8")).skills["claude-code:a-skill"];
    expect(acmeEntry.status).toBe("approved");
    expect(acmeEntry.removed_at).toBeNull();

    const switchedBack = await switchProfileAssets("personal", "acme", lifecyclePaths);

    expect(lstatSync(join(common.codexSkillsDir, "a-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(common.codexSkillsDir, "b-skill"))).toBe(false);
    expect(switchedBack.installedSkills).toContain("a-skill");

    const personalEntry = JSON.parse(readFileSync(personalManifestPath, "utf8")).skills["claude-code:b-skill"];
    expect(personalEntry.status).toBe("approved");
    expect(personalEntry.removed_at).toBeNull();
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

describe("withProfileSwitchLock", () => {
  const lockPath = join("/tmp", `draft-with-lock-test-${process.pid}`);
  afterEach(() => rmSync(lockPath, { recursive: true, force: true }));

  it("acquires, runs fn, and releases", async () => {
    const result = await withProfileSwitchLock(() => "ran", lockPath);
    expect(result).toBe("ran");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases even when fn throws", async () => {
    await expect(withProfileSwitchLock(() => { throw new Error("boom"); }, lockPath)).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a concurrent caller gets undefined immediately without running fn, while the first holds the lock", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondFnCalled = { value: false };

    const first = withProfileSwitchLock(async () => {
      await firstDone;
      return "first";
    }, lockPath);

    // give the first call a tick to actually acquire the lock directory
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(lockPath)).toBe(true);

    const second = await withProfileSwitchLock(() => {
      secondFnCalled.value = true;
      return "second";
    }, lockPath);

    expect(second).toBeUndefined();
    expect(secondFnCalled.value).toBe(false);

    releaseFirst();
    expect(await first).toBe("first");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers a lock abandoned by a crashed holder (dead pid): fn runs and the lock is released after", async () => {
    mkdirSync(lockPath, { recursive: true });
    // PID 999999 is very unlikely to be a live process — simulates a switch
    // that died mid-flight and never ran its release.
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999, token: "dead-token" }));

    const result = await withProfileSwitchLock(() => "recovered", lockPath);
    expect(result).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("still skips when the existing lock is held by a live process", async () => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-token" }));

    const fnCalled = { value: false };
    const result = await withProfileSwitchLock(() => { fnCalled.value = true; return "ran"; }, lockPath);
    expect(result).toBeUndefined();
    expect(fnCalled.value).toBe(false);
    // The live holder's lock is left untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token).toBe("live-token");
  });

  it("does not delete a lock now owned by someone else (stale-takeover-then-late-release is a no-op)", () => {
    // Original holder acquired with "old-token"...
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "old-token" }));

    // ...then a new owner takes over (as acquireProfileSwitchLock's
    // stale-takeover path does: rmSync + re-mkdir with its own token).
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "new-token" }));

    // The original (stale) holder finally gets around to releasing with its
    // now-outdated token — must be a no-op, not delete the new owner's lock.
    releaseProfileSwitchLock("old-token", lockPath);

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token).toBe("new-token");

    // The actual new owner's release, with the matching token, does work.
    releaseProfileSwitchLock("new-token", lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("personal MCP profile-switch lifecycle", () => {
  it("switch A -> B -> A deactivates/reinstalls each profile's personal MCP config, never tombstoning", async () => {
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
    mkdirSync(join(common.activeProfileFile, ".."), { recursive: true });
    writeFileSync(common.activeProfileFile, "acme\n");

    const acmeMcpManifestPath = join(common.workspacesDir, "acme", "config", "mcp-manifest.json");
    const personalMcpManifestPath = join(common.workspacesDir, "personal", "config", "mcp-manifest.json");
    const canonicalA: CanonicalMcp = { type: "http", url: "https://a.example.com" };
    const canonicalB: CanonicalMcp = { type: "http", url: "https://b.example.com" };

    // Seed acme's approval and let it install live (acme is the active profile).
    await installPersonalMcps(
      [{ id: "codex:a-mcp", name: "a-mcp", source_agent: "codex", canonical: canonicalA, original_config: {} }],
      { claudeConfigPath: common.claudeConfigPath, codexConfigPath: common.codexConfigPath, manifestPath: acmeMcpManifestPath },
    );
    // Seed "personal" profile's approval too, but it isn't active yet, so its
    // config entry is not live on disk — matches how a real inactive
    // profile's manifest looks (approved, but currently un-synced).
    await installPersonalMcps(
      [{ id: "codex:b-mcp", name: "b-mcp", source_agent: "codex", canonical: canonicalB, original_config: {} }],
      {
        claudeConfigPath: join(common.workspacesDir, "unused-claude.json"),
        codexConfigPath: join(common.workspacesDir, "unused-codex", "config.toml"),
        manifestPath: personalMcpManifestPath,
      },
    );

    expect(readAgentMcps("claude-code", common.claudeConfigPath)["a-mcp"]).toBeDefined();
    expect(readAgentMcps("claude-code", common.claudeConfigPath)["b-mcp"]).toBeUndefined();

    const switched = await switchProfileAssets("acme", "personal", lifecyclePaths);

    expect(readAgentMcps("claude-code", common.claudeConfigPath)["a-mcp"]).toBeUndefined();
    expect(readAgentMcps("claude-code", common.claudeConfigPath)["b-mcp"]).toBeDefined();
    expect(switched.installedMcps).toContain("b-mcp");
    expect(switched.removedMcps).toContain("a-mcp");

    const acmeEntry = JSON.parse(readFileSync(acmeMcpManifestPath, "utf8")).mcps["codex:a-mcp"];
    expect(acmeEntry.removed_at).toBeNull();

    const switchedBack = await switchProfileAssets("personal", "acme", lifecyclePaths);

    expect(readAgentMcps("claude-code", common.claudeConfigPath)["a-mcp"]).toBeDefined();
    expect(readAgentMcps("claude-code", common.claudeConfigPath)["b-mcp"]).toBeUndefined();
    expect(switchedBack.installedMcps).toContain("a-mcp");

    const personalEntry = JSON.parse(readFileSync(personalMcpManifestPath, "utf8")).mcps["codex:b-mcp"];
    expect(personalEntry.removed_at).toBeNull();
  });
});
