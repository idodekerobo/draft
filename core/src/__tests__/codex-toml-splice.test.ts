// core/src/__tests__/codex-toml-splice.test.ts
// Empirical test #2: verify comment-preserving TOML splice for Codex MCP entries.
// Fixtures include: comments, quoted keys, unrelated sections, arrays, nested tables.

import { describe, it, expect } from "bun:test";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readAgentMcps, writeAgentMcp, removeAgentMcp } from "../agents/mcp";

const FIXTURE = `
# Codex global config
# Managed by user — do not delete

[model]
provider = "anthropic"
name = "claude-opus-4-8"

[tools]
# Allow shell access
shell = true

[mcp_servers."existing-server"]
url = "https://existing.example.com/mcp"
bearer_token_env_var = "MY_TOKEN"

# A section with an array
[auth]
allowed_users = ["alice", "bob"]

[mcp_servers."another-server"]
url = "https://another.example.com/mcp"
`.trim();

async function withFixture(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<string> {
  const path = join(tmpdir(), `codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
  await writeFile(path, content, "utf8");
  try {
    await fn(path);
    return await readFile(path, "utf8");
  } finally {
    await unlink(path).catch(() => {});
  }
}

describe("writeAgentMcp (codex) — splice into fixture", () => {
  it("adds a new MCP entry without touching other sections", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await writeAgentMcp("codex", "granola", {
        url: "https://mcp.granola.so/mcp",
        bearer_token_env_var: "DRAFT_MCP_GRANOLA_A1B2C3_TOKEN",
      }, path);
    });

    // New entry present
    expect(result).toContain(`[mcp_servers."granola"]`);
    expect(result).toContain(`url = "https://mcp.granola.so/mcp"`);

    // Existing sections preserved
    expect(result).toContain(`[model]`);
    expect(result).toContain(`provider = "anthropic"`);
    expect(result).toContain(`# Codex global config`);
    expect(result).toContain(`[tools]`);
    expect(result).toContain(`# Allow shell access`);
    expect(result).toContain(`shell = true`);
    expect(result).toContain(`[mcp_servers."existing-server"]`);
    expect(result).toContain(`[mcp_servers."another-server"]`);
    expect(result).toContain(`[auth]`);
    expect(result).toContain(`allowed_users = [`);
  });

  it("updates an existing MCP entry in-place, preserving surrounding content", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await writeAgentMcp("codex", "existing-server", {
        url: "https://updated.example.com/mcp",
        bearer_token_env_var: "NEW_TOKEN",
      }, path);
    });

    expect(result).toContain(`url = "https://updated.example.com/mcp"`);
    expect(result).toContain(`bearer_token_env_var = "NEW_TOKEN"`);
    expect(result).not.toContain(`https://existing.example.com/mcp`);

    // Other sections unchanged
    expect(result).toContain(`[model]`);
    expect(result).toContain(`# Codex global config`);
    expect(result).toContain(`[mcp_servers."another-server"]`);
    expect(result).toContain(`[auth]`);
  });

  it("handles MCP names with hyphens (quoted TOML key)", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await writeAgentMcp("codex", "my-new-server", { url: "https://new.example.com" }, path);
    });
    expect(result).toContain(`[mcp_servers."my-new-server"]`);
  });

  it("does not corrupt non-MCP sections", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await writeAgentMcp("codex", "new-entry", { url: "https://new.example.com" }, path);
    });

    const nonMcpLines = FIXTURE.split("\n").filter(
      (l) => !l.includes("mcp_servers") && !l.includes("existing-server") && !l.includes("another-server") && !l.includes("MY_TOKEN") && !l.includes("existing.example.com") && !l.includes("another.example.com"),
    );
    for (const line of nonMcpLines) {
      if (line.trim()) expect(result).toContain(line.trim());
    }
  });
});

describe("removeAgentMcp (codex)", () => {
  it("removes only the target MCP section, leaving others intact", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await removeAgentMcp("codex", "existing-server", path);
    });

    expect(result).not.toContain(`[mcp_servers."existing-server"]`);
    expect(result).not.toContain(`https://existing.example.com/mcp`);

    expect(result).toContain(`[mcp_servers."another-server"]`);
    expect(result).toContain(`[model]`);
    expect(result).toContain(`[auth]`);
    expect(result).toContain(`# Codex global config`);
  });

  it("is a no-op if the target MCP does not exist", async () => {
    const result = await withFixture(FIXTURE, async (path) => {
      await removeAgentMcp("codex", "nonexistent", path);
    });

    expect(result).toContain(`[mcp_servers."existing-server"]`);
    expect(result).toContain(`[mcp_servers."another-server"]`);
  });
});

describe("readAgentMcps (codex)", () => {
  it("reads all MCP server entries from a TOML fixture", async () => {
    const path = join(tmpdir(), `codex-read-test-${Date.now()}.toml`);
    await writeFile(path, FIXTURE, "utf8");
    try {
      const mcps = readAgentMcps("codex", path);
      expect(Object.keys(mcps)).toContain("existing-server");
      expect(Object.keys(mcps)).toContain("another-server");
      expect(mcps["existing-server"]["url"]).toBe("https://existing.example.com/mcp");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it("returns empty object for missing file", () => {
    expect(readAgentMcps("codex", "/tmp/does-not-exist-draft-test.toml")).toEqual({});
  });

  it("returns empty object for missing file (claude-code)", () => {
    expect(readAgentMcps("claude-code", "/tmp/does-not-exist-draft-test.json")).toEqual({});
  });
});
