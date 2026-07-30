import { readIntegrations, writeIntegrations } from "draft-core/config";
import { findMcpServer, sanitizeMcpMessage, selectConnectedMcpServer } from "draft-core/integrations/mcp-health";
import { resolveRunnerBin } from "draft-core/agents/headless";
import type { SourceErrorCode } from "../synthesizers/source-result";

export type McpVerification =
  | { ok: true; serverId: string }
  | { ok: false; code: SourceErrorCode; message: string };

export type PreparedMcpIntegration =
  | { enabled: false }
  | { enabled: true; verification: McpVerification };

function normalizeFailure(message: string): SourceErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("auth") || lower.includes("token") || lower.includes("unauthorized")) return "mcp_auth";
  if (lower.includes("rate") || lower.includes("429")) return "mcp_rate_limited";
  return "mcp_connect";
}

export async function listClaudeMcpServers(
  workspace: string,
  resolve = resolveRunnerBin,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const claudeBin = await resolve("claude");
  if (!claudeBin) return { exitCode: 127, stdout: "", stderr: "Claude Code CLI was not found." };
  try {
    const processHandle = Bun.spawn([claudeBin, "mcp", "list"], {
      cwd: workspace,
      env: { ...process.env, DRAFT_SUPPRESS_SESSION_END_HOOK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout as ReadableStream).text(),
      new Response(processHandle.stderr as ReadableStream).text(),
      processHandle.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function prepareMcpIntegration(options: {
  workspace: string;
  source: "granola" | "fireflies";
  preferredIds: readonly string[];
  resolve?: typeof resolveRunnerBin;
}): Promise<PreparedMcpIntegration> {
  const integrationsResult = readIntegrations(options.workspace);
  const integrations = integrationsResult.ok ? integrationsResult.integrations : {};
  const entry = integrations[options.source];
  if (!entry?.connected) return { enabled: false };

  const listing = await listClaudeMcpServers(options.workspace, options.resolve);
  if (listing.exitCode !== 0) {
    const message = sanitizeMcpMessage(listing.stderr || "Could not inspect Claude MCP servers.");
    return { enabled: true, verification: { ok: false, code: listing.exitCode === 127 ? "mcp_missing" : normalizeFailure(message), message } };
  }

  if (entry.mcp_server_id) {
    const selected = findMcpServer(listing.stdout, entry.mcp_server_id);
    if (selected?.state === "connected") {
      return { enabled: true, verification: { ok: true, serverId: selected.id } };
    }
    const message = selected?.message ?? `Claude MCP server "${entry.mcp_server_id}" is not registered.`;
    return { enabled: true, verification: { ok: false, code: selected ? normalizeFailure(message) : "mcp_missing", message } };
  }

  const selected = selectConnectedMcpServer(listing.stdout, options.preferredIds);
  if (!selected) {
    return {
      enabled: true,
      verification: {
        ok: false,
        code: "mcp_missing",
        message: `No connected ${options.source} MCP server was found.`,
      },
    };
  }

  writeIntegrations(options.workspace, {
    ...integrations,
    [options.source]: { ...entry, mcp_server_id: selected.id },
  });
  return { enabled: true, verification: { ok: true, serverId: selected.id } };
}
