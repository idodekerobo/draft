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

import { capture } from "../exec";
import { writeSecrets, writeIntegrations, readIntegrations } from "../config";

export type FirefliesResult =
  | { ok: true }
  | { ok: false; error: string };

export async function registerFirefliesMCP(apiKey: string): Promise<FirefliesResult> {
  const check = await capture(["claude", "mcp", "list"]);
  const alreadyRegistered = check.exitCode === 0 && check.stdout.toLowerCase().includes("fireflies");

  if (!alreadyRegistered) {
    const connection = await capture([
      "claude", "mcp", "add", "--scope", "user", "fireflies", "--transport", "http",
      "https://api.fireflies.ai/mcp", "-H", `Authorization: Bearer ${apiKey}`,
    ]);
    if (connection.exitCode !== 0) {
      return {
        ok: false,
        error: connection.stderr || connection.stdout || "Could not register the Fireflies MCP server.",
      };
    }
  }

  return { ok: true };
}

export function writeFirefliesConfig(workspace: string, apiKey: string): void {
  writeSecrets(workspace, { fireflies_api_token: apiKey });

  const existing = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existing.ok ? existing.integrations : {}),
    fireflies: { connected: true, last_connected: new Date().toISOString() },
  });
}
