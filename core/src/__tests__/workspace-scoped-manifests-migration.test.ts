import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { migrateWorkspaceScopedManifests } from "../migrations/20260629213430_workspace_scoped_manifests";

const TMP = join("/tmp", `draft-workspace-manifest-migration-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("workspace-scoped manifest migration", () => {
  it("distributes personal and team skill and MCP entries into profile manifests", async () => {
    const stateDir = join(TMP, ".draft", "state");
    const skillGlobal = join(stateDir, "skill-manifest.json");
    const mcpGlobal = join(stateDir, "mcp-manifest.json");

    writeJson(skillGlobal, {
      version: 4,
      schema_version: 4,
      min_reader_version: 1,
      skills: {
        "claude-code:personal-skill": {
          id: "claude-code:personal-skill",
          name: "personal-skill",
          source: "user",
          source_agent: "claude-code",
        },
        "team:acme:review": {
          id: "team:acme:review",
          name: "review",
          source: "team",
          profile: "acme",
          source_agent: "claude-code",
        },
      },
      name_conflicts: {
        "personal-skill": {
          agents: ["claude-code", "codex"],
          resolved: false,
          authoritative_agent: null,
        },
      },
    });
    writeJson(mcpGlobal, {
      version: 4,
      schema_version: 4,
      mcps: {
        "codex:personal-mcp": {
          id: "codex:personal-mcp",
          name: "personal-mcp",
          source: "user",
          source_agent: "codex",
        },
        "team:acme:linear": {
          id: "team:acme:linear",
          name: "linear",
          source: "team",
          profile: "acme",
          source_agent: "claude-code",
        },
      },
      name_conflicts: {},
    });

    await migrateWorkspaceScopedManifests(TMP);

    const defaultSkills = readJson(join(TMP, ".draft", "workspaces", "default", "config", "skill-manifest.json"));
    const acmeSkills = readJson(join(TMP, ".draft", "workspaces", "acme", "config", "skill-manifest.json"));
    const defaultMcps = readJson(join(TMP, ".draft", "workspaces", "default", "config", "mcp-manifest.json"));
    const acmeMcps = readJson(join(TMP, ".draft", "workspaces", "acme", "config", "mcp-manifest.json"));

    expect(defaultSkills.schema_version).toBe(5);
    expect(defaultSkills.skills["claude-code:personal-skill"]).toMatchObject({
      id: "claude-code:personal-skill",
      kind: "personal",
    });
    expect(acmeSkills.skills["team:review"]).toMatchObject({
      id: "team:review",
      kind: "team",
    });
    expect(defaultSkills.name_conflicts["personal-skill"]).toBeDefined();
    expect(acmeSkills.name_conflicts).toEqual({});
    expect(defaultMcps.schema_version).toBe(5);
    expect(defaultMcps.mcps["codex:personal-mcp"]).toMatchObject({
      id: "codex:personal-mcp",
      kind: "personal",
    });
    expect(acmeMcps.mcps["team:linear"]).toMatchObject({
      id: "team:linear",
      kind: "team",
    });

    expect(existsSync(skillGlobal)).toBe(false);
    expect(existsSync(mcpGlobal)).toBe(false);
    expect(existsSync(join(stateDir, "skill-manifest-v4-backup.json"))).toBe(true);
    expect(existsSync(join(stateDir, "mcp-manifest-v4-backup.json"))).toBe(true);
  });

  it("is idempotent after the v4 manifests have been backed up", async () => {
    const skillGlobal = join(TMP, ".draft", "state", "skill-manifest.json");
    writeJson(skillGlobal, {
      version: 4,
      schema_version: 4,
      min_reader_version: 1,
      skills: {
        "claude-code:review": {
          id: "claude-code:review",
          name: "review",
          source: "user",
        },
      },
      name_conflicts: {},
    });

    await migrateWorkspaceScopedManifests(TMP);
    const target = join(TMP, ".draft", "workspaces", "default", "config", "skill-manifest.json");
    const first = readFileSync(target, "utf8");
    await migrateWorkspaceScopedManifests(TMP);

    expect(readFileSync(target, "utf8")).toBe(first);
    expect(existsSync(join(TMP, ".draft", "state", "skill-manifest-v4-backup.json"))).toBe(true);
  });

  it("merges into existing v5 targets without overwriting existing entries", async () => {
    const skillGlobal = join(TMP, ".draft", "state", "skill-manifest.json");
    const mcpGlobal = join(TMP, ".draft", "state", "mcp-manifest.json");
    const skillTarget = join(TMP, ".draft", "workspaces", "default", "config", "skill-manifest.json");
    const mcpTarget = join(TMP, ".draft", "workspaces", "default", "config", "mcp-manifest.json");
    writeJson(skillGlobal, {
      version: 4,
      schema_version: 4,
      min_reader_version: 1,
      skills: {
        "claude-code:review": {
          id: "claude-code:review",
          name: "review",
          source: "user",
          status: "pending",
        },
        "codex:notes": {
          id: "codex:notes",
          name: "notes",
          source: "user",
          status: "approved",
        },
      },
      name_conflicts: {
        review: { agents: ["claude-code", "codex"], resolved: false, authoritative_agent: null },
      },
    });
    writeJson(mcpGlobal, {
      version: 4,
      schema_version: 4,
      mcps: {
        "codex:linear": {
          id: "codex:linear",
          name: "linear",
          source: "user",
          source_agent: "codex",
          sync_canonical_hash: "sha256:migrated",
        },
        "claude-code:figma": {
          id: "claude-code:figma",
          name: "figma",
          source: "user",
          source_agent: "claude-code",
        },
      },
      name_conflicts: {},
    });
    writeJson(skillTarget, {
      version: 5,
      schema_version: 5,
      min_reader_version: 1,
      skills: {
        "claude-code:review": {
          id: "claude-code:review",
          name: "review",
          kind: "personal",
          status: "approved",
          marker: "keep-me",
        },
      },
      name_conflicts: {
        review: { agents: ["claude-code", "codex"], resolved: true, authoritative_agent: "claude-code" },
      },
    });
    writeJson(mcpTarget, {
      version: 5,
      schema_version: 5,
      mcps: {
        "codex:linear": {
          id: "codex:linear",
          name: "linear",
          kind: "personal",
          sync_canonical_hash: "sha256:existing",
          marker: "keep-mcp",
        },
      },
      name_conflicts: {},
    });

    await migrateWorkspaceScopedManifests(TMP);

    const merged = readJson(skillTarget);
    expect(merged.skills["claude-code:review"]).toMatchObject({
      status: "approved",
      marker: "keep-me",
    });
    expect(merged.skills["codex:notes"]).toMatchObject({
      id: "codex:notes",
      kind: "personal",
      status: "approved",
    });
    expect(merged.name_conflicts.review).toMatchObject({
      resolved: true,
      authoritative_agent: "claude-code",
    });

    const mergedMcps = readJson(mcpTarget);
    expect(mergedMcps.mcps["codex:linear"]).toMatchObject({
      sync_canonical_hash: "sha256:existing",
      marker: "keep-mcp",
    });
    expect(mergedMcps.mcps["claude-code:figma"]).toMatchObject({
      id: "claude-code:figma",
      kind: "personal",
    });
  });

  it("preserves the global manifest when an existing target cannot be merged safely", async () => {
    const skillGlobal = join(TMP, ".draft", "state", "skill-manifest.json");
    const skillBackup = join(TMP, ".draft", "state", "skill-manifest-v4-backup.json");
    const skillTarget = join(TMP, ".draft", "workspaces", "default", "config", "skill-manifest.json");
    writeJson(skillGlobal, {
      version: 4,
      schema_version: 4,
      min_reader_version: 1,
      skills: {
        "claude-code:review": {
          id: "claude-code:review",
          name: "review",
          source: "user",
        },
      },
      name_conflicts: {},
    });
    writeJson(skillTarget, {
      version: 4,
      schema_version: 4,
      skills: {},
      name_conflicts: {},
    });

    await expect(migrateWorkspaceScopedManifests(TMP)).rejects.toThrow("non-v5 manifest");

    expect(existsSync(skillGlobal)).toBe(true);
    expect(existsSync(skillBackup)).toBe(false);
    expect(readJson(skillTarget).schema_version).toBe(4);
  });
});
