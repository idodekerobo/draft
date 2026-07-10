import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  approveMcps,
  installPersonalMcps,
  installTeamMcps,
  uninstallPersonalMcps,
  type PersonalMcpInput,
} from "../sync/mcp-sync";
import { readMcpManifest, type CanonicalMcp } from "../sync/manifest";
import { readAgentMcps } from "../agents/mcp";

const TMP = join("/tmp", `draft-mcp-sync-${process.pid}`);
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function mcpOpts(tag: string) {
  const claudeConfigPath = join(TMP, tag, "claude.json");
  const codexConfigPath = join(TMP, tag, "codex", "config.toml");
  const manifestPath = join(TMP, tag, "skill-manifest.json"); // note: mcp manifest, path name kept generic
  mkdirSync(join(claudeConfigPath, ".."), { recursive: true });
  mkdirSync(join(codexConfigPath, ".."), { recursive: true });
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  return { claudeConfigPath, codexConfigPath, manifestPath };
}

const canonical: CanonicalMcp = { type: "http", url: "https://mcp.example.com" };
const otherCanonical: CanonicalMcp = { type: "http", url: "https://other.example.com" };

function writeClaudeJson(path: string, mcpServers: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2) + "\n");
}

describe("installPersonalMcps", () => {
  it("missing target: installs and writes the target config", async () => {
    const opts = mcpOpts("missing");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };

    const result = await installPersonalMcps([input], opts);

    expect(result.installed).toEqual(["linear"]);
    expect(result.conflicts).toEqual([]);
    const claudeMcps = readAgentMcps("claude-code", opts.claudeConfigPath);
    expect(claudeMcps.linear).toMatchObject({ url: canonical.url });
    const manifest = readMcpManifest(opts.manifestPath);
    expect(manifest.mcps["codex:linear"]).toMatchObject({ kind: "personal" });
    expect(manifest.mcps["codex:linear"].removed_at).toBeNull();
  });

  it("owned target: adopts an already-correct target entry without rewriting", async () => {
    const opts = mcpOpts("owned");
    writeClaudeJson(opts.claudeConfigPath, { linear: { url: canonical.url } });
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };

    const result = await installPersonalMcps([input], opts);

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(["linear"]);
    expect(result.conflicts).toEqual([]);
    const manifest = readMcpManifest(opts.manifestPath);
    expect(manifest.mcps["codex:linear"].kind).toBe("personal");
  });

  it("team-name-collision (adopt-then-corrupt regression): identical config to an active team MCP is blocked, not adopted", async () => {
    const opts = mcpOpts("teamcollision");
    await installTeamMcps(
      [{ name: "linear", canonical, required_secrets: [] }],
      TMP,
      "acme",
      opts,
    );
    const teamEntryBefore = readMcpManifest(opts.manifestPath).mcps["team:linear"];
    expect(teamEntryBefore.install_state).toBe("installed");

    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    const result = await installPersonalMcps([input], opts);

    expect(result.conflicts).toEqual([{ name: "linear", reason: "team-name-collision" }]);
    const manifest = readMcpManifest(opts.manifestPath);
    expect(manifest.mcps["team:linear"]).toEqual(teamEntryBefore);
    expect(manifest.mcps["codex:linear"].install_state).toBe("conflict");

    // A subsequent deactivate of the (never-actually-installed) personal
    // entry must never touch the team's live config.
    await uninstallPersonalMcps(opts);
    const claudeMcps = readAgentMcps("claude-code", opts.claudeConfigPath);
    expect(claudeMcps.linear).toBeDefined();
  });

  it("team install is blocked by a live personal entry of the same name (reverse adopt-then-corrupt regression)", async () => {
    const opts = mcpOpts("reversecollision");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    await installPersonalMcps([input], opts);
    const personalEntryBefore = readMcpManifest(opts.manifestPath).mcps["codex:linear"];
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();

    // Team ships an MCP with the same name and an identical canonical — the
    // observed config matches, but the slot is personal-owned. Team install
    // must conflict, never adopt.
    const result = await installTeamMcps(
      [{ name: "linear", canonical, required_secrets: [] }],
      TMP,
      "acme",
      opts,
    );

    expect(result.conflicts).toEqual([{ name: "linear", reason: "personal-name-collision" }]);
    const manifest = readMcpManifest(opts.manifestPath);
    expect(manifest.mcps["team:linear"].install_state).toBe("conflict");
    // The personal entry and its live config mirror are untouched.
    expect(manifest.mcps["codex:linear"]).toEqual(personalEntryBefore);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toMatchObject({ url: canonical.url });
  });

  it("personal-name-collision: an unrelated config already occupies the target name", async () => {
    const opts = mcpOpts("personalcollision");
    writeClaudeJson(opts.claudeConfigPath, { linear: { url: otherCanonical.url } });
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };

    const result = await installPersonalMcps([input], opts);

    expect(result.conflicts).toEqual([{ name: "linear", reason: "personal-name-collision" }]);
    const claudeMcps = readAgentMcps("claude-code", opts.claudeConfigPath);
    expect(claudeMcps.linear).toMatchObject({ url: otherCanonical.url }); // untouched
  });

  it("is idempotent — calling twice in a row is safe", async () => {
    const opts = mcpOpts("idempotent");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };

    const first = await installPersonalMcps([input], opts);
    const second = await installPersonalMcps([input], opts);

    expect(first.installed).toEqual(["linear"]);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toEqual(["linear"]);
    expect(second.conflicts).toEqual([]);
  });
});

describe("uninstallPersonalMcps", () => {
  it("removes the target config entry but leaves the manifest entry approved", async () => {
    const opts = mcpOpts("deactivate");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    await installPersonalMcps([input], opts);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();

    await uninstallPersonalMcps(opts);

    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeUndefined();
    const entry = readMcpManifest(opts.manifestPath).mcps["codex:linear"];
    expect(entry.removed_at).toBeNull();
  });

  it("switch A -> B -> A restores A's personal MCP config, never tombstoning", async () => {
    const opts = mcpOpts("roundtrip");
    const inputA: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    const inputB: PersonalMcpInput = {
      id: "codex:notion", name: "notion", source_agent: "codex", canonical: otherCanonical, original_config: {},
    };

    await installPersonalMcps([inputA], opts);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();

    await uninstallPersonalMcps(opts);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeUndefined();

    await installPersonalMcps([inputB], opts);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).notion).toBeDefined();

    await uninstallPersonalMcps(opts);
    const reinstallResult = await installPersonalMcps([inputA], opts);

    expect(reinstallResult.installed).toEqual(["linear"]);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();
    expect(readMcpManifest(opts.manifestPath).mcps["codex:linear"].removed_at).toBeNull();
  });

  it("target-modified conflict: config now points elsewhere, entry left untouched", async () => {
    const opts = mcpOpts("targetmodified");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    await installPersonalMcps([input], opts);
    writeClaudeJson(opts.claudeConfigPath, { linear: { url: otherCanonical.url } });

    const result = await uninstallPersonalMcps(opts);

    expect(result.conflicts).toEqual([{ name: "linear", reason: "target-modified" }]);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toMatchObject({ url: otherCanonical.url });
    const entry = readMcpManifest(opts.manifestPath).mcps["codex:linear"];
    expect(entry.removed_at).toBeNull();
  });

  it("already-deactivated entry (target already gone) is a no-op", async () => {
    const opts = mcpOpts("alreadygone");
    const input: PersonalMcpInput = {
      id: "codex:linear", name: "linear", source_agent: "codex", canonical, original_config: {},
    };
    await installPersonalMcps([input], opts);
    writeClaudeJson(opts.claudeConfigPath, {});

    const result = await uninstallPersonalMcps(opts);

    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("ignores team-kind entries entirely", async () => {
    const opts = mcpOpts("ignoreteam");
    await installTeamMcps(
      [{ name: "linear", canonical, required_secrets: [] }],
      TMP,
      "acme",
      opts,
    );
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();
    expect(readAgentMcps("codex", opts.codexConfigPath).linear).toBeDefined();

    await uninstallPersonalMcps(opts);

    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toBeDefined();
    expect(readAgentMcps("codex", opts.codexConfigPath).linear).toBeDefined();
  });
});

describe("approveMcps delegation", () => {
  it("delegates to installPersonalMcps and surfaces a conflict when the target changed since detection", async () => {
    const opts = mcpOpts("approve");
    writeClaudeJson(opts.claudeConfigPath, { linear: { url: otherCanonical.url } });

    const result = await approveMcps(
      [{ id: "codex:linear", name: "linear", source_agent: "codex", config: {}, canonical }],
      opts,
    );

    expect(result.conflicts).toEqual([{ name: "linear", reason: "personal-name-collision" }]);
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toMatchObject({ url: otherCanonical.url });
  });

  it("writes the manifest entry once (no double-write) on a clean approval", async () => {
    const opts = mcpOpts("approveclean");

    const result = await approveMcps(
      [{ id: "codex:linear", name: "linear", source_agent: "codex", config: {}, canonical }],
      opts,
    );

    expect(result.installed).toEqual(["linear"]);
    const manifest = readMcpManifest(opts.manifestPath);
    expect(manifest.mcps["codex:linear"]).toMatchObject({ kind: "personal" });
    expect(readAgentMcps("claude-code", opts.claudeConfigPath).linear).toMatchObject({ url: canonical.url });
  });
});
