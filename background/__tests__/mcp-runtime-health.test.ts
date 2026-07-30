import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readIntegrations, writeIntegrations } from "draft-core/config";
import { listClaudeMcpServers, prepareMcpIntegration } from "../integrations/mcp-runtime-health";

const ROOT = `/tmp/draft-mcp-runtime-health-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function fakeClaude(output: string): string {
  mkdirSync(ROOT, { recursive: true });
  const path = join(ROOT, `claude-${crypto.randomUUID()}`);
  writeFileSync(path, `#!/bin/bash
[ "$DRAFT_SUPPRESS_SESSION_END_HOOK" = "1" ] || exit 9
printf '%s\\n' '${output.replaceAll("'", "'\\''")}'
`);
  chmodSync(path, 0o755);
  return path;
}

describe("runtime MCP preparation", () => {
  it("does no Claude work for a disconnected integration", async () => {
    writeIntegrations(ROOT, { granola: { connected: false, mode: "mcp" } });
    let resolved = false;
    const result = await prepareMcpIntegration({
      workspace: ROOT,
      source: "granola",
      preferredIds: ["granola", "granola-mcp"],
      resolve: async () => { resolved = true; return null; },
    });
    expect(result).toEqual({ enabled: false });
    expect(resolved).toBe(false);
  });

  it("lazily persists the exact connected server for a legacy configuration", async () => {
    writeIntegrations(ROOT, { granola: { connected: true, mode: "mcp" } });
    const binary = fakeClaude("granola: remote - ✔ Connected\ngranola-mcp: command - ✘ Failed to connect — closed");
    const result = await prepareMcpIntegration({
      workspace: ROOT,
      source: "granola",
      preferredIds: ["granola", "granola-mcp"],
      resolve: async () => binary,
    });
    expect(result).toEqual({ enabled: true, verification: { ok: true, serverId: "granola" } });
    const integrations = readIntegrations(ROOT);
    expect(integrations.ok && integrations.integrations.granola?.mcp_server_id).toBe("granola");
  });

  it("honors a persisted exact ID instead of silently switching to another server", async () => {
    writeIntegrations(ROOT, { granola: { connected: true, mode: "mcp", mcp_server_id: "granola-mcp" } });
    const binary = fakeClaude("granola: remote - ✔ Connected\ngranola-mcp: command - ✘ Failed to connect — closed");
    const result = await prepareMcpIntegration({
      workspace: ROOT,
      source: "granola",
      preferredIds: ["granola", "granola-mcp"],
      resolve: async () => binary,
    });
    expect(result).toMatchObject({ enabled: true, verification: { ok: false, code: "mcp_connect" } });
  });
});

describe("listClaudeMcpServers", () => {
  it("returns exit code 127 (never throws) when claude cannot be resolved on PATH", async () => {
    let resolveCalledWith: string | undefined;
    const result = await listClaudeMcpServers(ROOT, async name => { resolveCalledWith = name; return null; });
    expect(result).toMatchObject({ exitCode: 127 });
    expect(resolveCalledWith).toBe("claude");
  });

  // The daemon's LaunchAgent PATH is baked once at install.sh time from
  // `command -v claude`; a bare `Bun.spawn(['claude', ...])` throws "Executable
  // not found in $PATH" whenever Claude Code was installed after Draft's daemon,
  // or lives somewhere install.sh didn't scan. Resolving via resolveRunnerBin and
  // spawning that exact path avoids depending on the daemon process's own PATH.
  it("spawns the resolved binary path, suppresses SessionEnd, and runs from the given workspace", async () => {
    mkdirSync(ROOT, { recursive: true });
    const realRoot = realpathSync(ROOT);
    const binary = join(ROOT, "fake-claude");
    writeFileSync(binary, `#!/bin/bash
[ "$DRAFT_SUPPRESS_SESSION_END_HOOK" = "1" ] || exit 9
[ "$PWD" = "${realRoot}" ] || exit 8
echo "granola: https://mcp.granola.ai/mcp - ✔ Connected"
`);
    chmodSync(binary, 0o755);
    const result = await listClaudeMcpServers(ROOT, async () => binary);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("granola");
  });
});
