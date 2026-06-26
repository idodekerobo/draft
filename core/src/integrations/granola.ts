// core/src/integrations/granola.ts — Granola integration logic
//
// Used by: draft-desktop (RPC handlers), draft-cli (future)
//
// registerGranolaMCP: idempotent — checks if already registered before adding.
// writeGranolaConfig: patch-writes secrets.json + integrations.json for the profile.

import { capture } from "../exec";
import { writeSecrets, writeIntegrations, readIntegrations } from "../config";

export type GranolaResult =
  | { ok: true }
  | { ok: false; error: string };

export async function registerGranolaMCP(): Promise<GranolaResult> {
  const check = await capture(["claude", "mcp", "list"]);
  const alreadyRegistered = check.exitCode === 0 && check.stdout.toLowerCase().includes("granola");

  if (!alreadyRegistered) {
    const connection = await capture([
      "claude", "mcp", "add", "granola-mcp", "npx", "granola-mcp-server",
    ]);
    if (connection.exitCode !== 0) {
      return {
        ok: false,
        error: connection.stderr || connection.stdout || "Could not register the Granola MCP server.",
      };
    }
  }

  return { ok: true };
}

export function writeGranolaConfig(
  workspace: string,
  mode: "mcp" | "api",
  apiKey?: string,
): void {
  const secretsPatch: Parameters<typeof writeSecrets>[1] = { granola_mode: mode };
  if (mode === "api" && apiKey) secretsPatch.granola_api_token = apiKey;

  writeSecrets(workspace, secretsPatch);

  const existing = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existing.ok ? existing.integrations : {}),
    granola: { connected: true, mode, last_connected: new Date().toISOString() },
  });
}
