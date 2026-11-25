import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionMcpConnection } from "./drivers/harness-driver";

export function claudeMcpNameAvailable(name: string, folderPath: string, userServers?: Record<string, unknown>): boolean {
  try {
    const userPath = join(homedir(), ".claude.json");
    const user = userServers ? null : existsSync(userPath) ? JSON.parse(readFileSync(userPath, "utf8")) : {};
    const personal = userServers ?? user.mcpServers ?? {};
    if (Object.hasOwn(personal, name) || Object.hasOwn(user?.projects?.[folderPath]?.mcpServers ?? {}, name)) return false;
    const projectPath = join(folderPath, ".mcp.json");
    if (!existsSync(projectPath)) return true;
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    return !Object.hasOwn(project.mcpServers ?? {}, name);
  } catch { return false; }
}

export function codexSessionMcpConfig(mcp: SessionMcpConnection, effective: Record<string, unknown>): Record<string, unknown> | null {
  const servers = effective.mcp_servers;
  if (servers && typeof servers === "object" && Object.hasOwn(servers, mcp.serverName)) return null;
  return { [`mcp_servers.${mcp.serverName}`]: { url: mcp.url, bearer_token_env_var: mcp.tokenEnvVar, required: false } };
}
