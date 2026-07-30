// core/src/integrations/granola.ts — Granola integration logic
//
// Used by: draft-desktop (RPC handlers), draft-cli (future)
//
// registerGranolaMCP: idempotent — checks if already registered before adding.
// writeGranolaConfig: patch-writes secrets.json + integrations.json for the profile.

import { capture, GUI_PATH } from "../exec";
import { writeSecrets, writeIntegrations, readIntegrations } from "../config";
import { findMcpServer, sanitizeMcpMessage, selectConnectedMcpServer } from "./mcp-health";

export type GranolaResult =
  | { ok: true; mcpServerId: string }
  | { ok: false; error: string };

const MCP_ENV = { PATH: GUI_PATH, DRAFT_SUPPRESS_SESSION_END_HOOK: "1" };

export async function registerGranolaMCP(workspace: string): Promise<GranolaResult> {
  const check = await capture(["claude", "mcp", "list"], { env: MCP_ENV, cwd: workspace });
  const connected = selectConnectedMcpServer(check.stdout, ["granola", "granola-mcp"]);
  if (connected) return { ok: true, mcpServerId: connected.id };

  const existing = findMcpServer(check.stdout, "granola-mcp");
  if (existing) {
    return { ok: false, error: `Granola MCP is registered but unavailable: ${existing.message ?? "connection failed"}` };
  }

  if (check.exitCode !== 0) {
    return { ok: false, error: sanitizeMcpMessage(check.stderr || "Could not inspect Claude MCP servers.") };
  }

  {
    const connection = await capture([
      "claude", "mcp", "add", "granola-mcp", "npx", "granola-mcp-server",
    ], { env: MCP_ENV, cwd: workspace });
    if (connection.exitCode !== 0) {
      return {
        ok: false,
        error: sanitizeMcpMessage(connection.stderr || connection.stdout || "Could not register the Granola MCP server."),
      };
    }
  }

  const verified = await capture(["claude", "mcp", "list"], { env: MCP_ENV, cwd: workspace });
  const added = findMcpServer(verified.stdout, "granola-mcp");
  return added?.state === "connected"
    ? { ok: true, mcpServerId: added.id }
    : { ok: false, error: `Granola MCP was added but is unavailable: ${sanitizeMcpMessage(added?.message ?? verified.stderr ?? "connection failed")}` };
}

export function writeGranolaConfig(
  workspace: string,
  mode: "mcp" | "api",
  apiKey?: string,
  mcpServerId?: string,
): void {
  const secretsPatch: Parameters<typeof writeSecrets>[1] = { granola_mode: mode };
  if (mode === "api" && apiKey) secretsPatch.granola_api_token = apiKey;

  writeSecrets(workspace, secretsPatch);

  const existing = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existing.ok ? existing.integrations : {}),
    granola: {
      connected: true,
      mode,
      ...(mode === "mcp" && mcpServerId ? { mcp_server_id: mcpServerId } : {}),
      last_connected: new Date().toISOString(),
    },
  });
}
