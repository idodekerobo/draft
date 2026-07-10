import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { migrateBackfillPersonalMcpManifests } from "../migrations/20260709223251_backfill_personal_mcp_manifests";

const TMP = join("/tmp", `draft-backfill-personal-mcps-migration-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function manifestPath(profile: string): string {
  return join(TMP, ".draft", "workspaces", profile, "config", "mcp-manifest.json");
}

function makeWorkspaceDir(profile: string): void {
  mkdirSync(join(TMP, ".draft", "workspaces", profile), { recursive: true });
}

function writeClaudeConfig(url: string, name = "linear"): void {
  writeJson(join(TMP, ".claude.json"), { mcpServers: { [name]: { url } } });
}

function personalEntry(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "codex:linear",
    name: "linear",
    source_agent: "codex",
    sync_canonical: { type: "http", url: "https://mcp.example.com" },
    sync_canonical_hash: "sha256:test",
    source_snapshot: { original_config: {} },
    env_var_mapping: {},
    synced_to: {},
    removed_at: null,
    kind: "personal",
    ...overrides,
  };
}

describe("backfill personal mcp manifests migration", () => {
  it("backfills other profiles with a verified, live personal MCP approval", async () => {
    writeClaudeConfig("https://mcp.example.com");
    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({
          synced_to: { "claude-code": { target_name: "linear", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });

    await migrateBackfillPersonalMcpManifests(TMP);

    const otherManifest = readJson(manifestPath("other"));
    expect(otherManifest.mcps["codex:linear"]).toMatchObject({ kind: "personal" });
  });

  it("never backfills an entry with no synced_to or whose live config doesn't match", async () => {
    writeClaudeConfig("https://different.example.com");
    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, mcps: {
        "codex:nosync": personalEntry({ id: "codex:nosync", name: "nosync", synced_to: {} }),
        "codex:stale": personalEntry({
          id: "codex:stale", name: "stale",
          synced_to: { "claude-code": { target_name: "linear", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });

    await migrateBackfillPersonalMcpManifests(TMP);

    expect(existsSync(manifestPath("other"))).toBe(false);
  });

  it("skips backfill entirely when two profiles disagree about the same MCP id's canonical url", async () => {
    // Both target names are live simultaneously (two differently-mirrored
    // slots), so both profiles' entries independently verify as live, but
    // they disagree about the canonical url for the same manifest id.
    writeJson(join(TMP, ".claude.json"), {
      mcpServers: {
        "linear-a": { url: "https://a.example.com" },
        "linear-b": { url: "https://b.example.com" },
      },
    });
    makeWorkspaceDir("acme");
    makeWorkspaceDir("profileb");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({
          sync_canonical: { type: "http", url: "https://a.example.com" },
          synced_to: { "claude-code": { target_name: "linear-a", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });
    writeJson(manifestPath("profileb"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({
          sync_canonical: { type: "http", url: "https://b.example.com" },
          synced_to: { "claude-code": { target_name: "linear-b", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });

    await migrateBackfillPersonalMcpManifests(TMP);

    expect(existsSync(manifestPath("other"))).toBe(false);
    expect(readJson(manifestPath("acme")).mcps["codex:linear"].sync_canonical.url).toBe("https://a.example.com");
    expect(readJson(manifestPath("profileb")).mcps["codex:linear"].sync_canonical.url).toBe("https://b.example.com");
  });

  it("never overwrites a profile's existing entry of any status, including its own tombstone", async () => {
    writeClaudeConfig("https://mcp.example.com");
    makeWorkspaceDir("acme");
    makeWorkspaceDir("tombstoned-profile");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({
          synced_to: { "claude-code": { target_name: "linear", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });
    writeJson(manifestPath("tombstoned-profile"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({ removed_at: new Date().toISOString() }),
      }, name_conflicts: {},
    });

    await migrateBackfillPersonalMcpManifests(TMP);

    const tombstonedProfileManifest = readJson(manifestPath("tombstoned-profile"));
    expect(tombstonedProfileManifest.mcps["codex:linear"].removed_at).not.toBeNull();
  });

  it("is idempotent — re-running the migration is a no-op", async () => {
    writeClaudeConfig("https://mcp.example.com");
    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, mcps: {
        "codex:linear": personalEntry({
          synced_to: { "claude-code": { target_name: "linear", synced_at: new Date().toISOString() } },
        }),
      }, name_conflicts: {},
    });

    await migrateBackfillPersonalMcpManifests(TMP);
    const firstRun = readJson(manifestPath("other"));
    await migrateBackfillPersonalMcpManifests(TMP);
    const secondRun = readJson(manifestPath("other"));

    expect(secondRun).toEqual(firstRun);
  });
});
