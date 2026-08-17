// core/src/integrations/fireflies.ts — Fireflies integration logic
//
// Used by: draft-desktop (RPC handlers), draft-cli (future)
//
// Single mode only (MCP-backed): Fireflies' remote MCP server requires a bearer
// token for headless/unattended auth regardless of mode, so unlike Granola there
// is no token-free path — the token is baked into the MCP registration itself.
//
// registerFirefliesMCP: idempotent — checks if already registered before adding.
// writeFirefliesConfig: patch-writes secrets.json + integrations.json for the profile.

import { capture, GUI_PATH } from "../exec";
import { writeSecrets, writeIntegrations, readIntegrations } from "../config";
import { findMcpServer, sanitizeMcpMessage } from "./mcp-health";

export type FirefliesResult =
  | { ok: true; mcpServerId: string }
  | { ok: false; error: string };

const MCP_ENV = { PATH: GUI_PATH, DRAFT_SUPPRESS_SESSION_END_HOOK: "1" };

export async function registerFirefliesMCP(apiKey: string, workspace: string): Promise<FirefliesResult> {
  // TODO: Decide whether this legacy local-storage helper remains in the self-hosted path.
  const check = await capture(["claude", "mcp", "list"], { env: MCP_ENV, cwd: workspace });
  const existing = findMcpServer(check.stdout, "fireflies");
  if (existing?.state === "connected") return { ok: true, mcpServerId: existing.id };
  if (existing) {
    return { ok: false, error: `Fireflies MCP is registered but unavailable: ${existing.message ?? "connection failed"}` };
  }
  if (check.exitCode !== 0) {
    return { ok: false, error: sanitizeMcpMessage(check.stderr || "Could not inspect Claude MCP servers.") };
  }

  {
    const connection = await capture([
      "claude", "mcp", "add", "--scope", "user", "fireflies", "--transport", "http",
      "https://api.fireflies.ai/mcp", "-H", `Authorization: Bearer ${apiKey}`,
    ], { env: MCP_ENV, cwd: workspace });
    if (connection.exitCode !== 0) {
      return {
        ok: false,
        error: sanitizeMcpMessage(connection.stderr || connection.stdout || "Could not register the Fireflies MCP server."),
      };
    }
  }

  const verified = await capture(["claude", "mcp", "list"], { env: MCP_ENV, cwd: workspace });
  const added = findMcpServer(verified.stdout, "fireflies");
  return added?.state === "connected"
    ? { ok: true, mcpServerId: added.id }
    : { ok: false, error: `Fireflies MCP was added but is unavailable: ${sanitizeMcpMessage(added?.message ?? verified.stderr ?? "connection failed")}` };
}

export function writeFirefliesConfig(workspace: string, apiKey: string, mcpServerId: string): void {
  // TODO: Decide whether this legacy local-storage helper remains in the self-hosted path.
  writeSecrets(workspace, { fireflies_api_token: apiKey });

  const existing = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existing.ok ? existing.integrations : {}),
    fireflies: { connected: true, mcp_server_id: mcpServerId, last_connected: new Date().toISOString() },
  });
}
