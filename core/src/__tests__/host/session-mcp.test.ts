import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMcpNameAvailable, codexSessionMcpConfig } from "../../host/session-mcp";

test("Claude checks personal and project names without overriding them", () => {
  const folder = mkdtempSync(join(tmpdir(), "draft-mcp-collision-"));
  try {
    expect(claudeMcpNameAvailable("draft_session_a", folder, {})).toBe(true);
    expect(claudeMcpNameAvailable("draft_session_a", folder, { draft_session_a: {} })).toBe(false);
    writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { draft_session_a: { url: "https://personal.test" } } }));
    expect(claudeMcpNameAvailable("draft_session_a", folder, {})).toBe(false);
    writeFileSync(join(folder, ".mcp.json"), "invalid");
    expect(claudeMcpNameAvailable("draft_session_a", folder, {})).toBe(false);
  } finally { rmSync(folder, { recursive: true }); }
});

test("Codex overlays only its own optional server and refuses an existing name", () => {
  const mcp = { serverName: "draft_session_a", url: "http://localhost:1234/mcp/a", tokenEnvVar: "DRAFT_SESSION_MCP_TOKEN", token: "secret", tokenFile: "/private/token" };
  expect(codexSessionMcpConfig(mcp, { mcp_servers: { personal: {} } })).toEqual({ "mcp_servers.draft_session_a": { url: mcp.url, bearer_token_env_var: mcp.tokenEnvVar, required: false } });
  expect(codexSessionMcpConfig(mcp, { mcp_servers: { draft_session_a: {} } })).toBeNull();
  expect(JSON.stringify(codexSessionMcpConfig(mcp, {}))).not.toContain("secret");
});
