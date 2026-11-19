import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Claude Code reads ${DRAFT_MCP_TOKEN} from the pane's environment when it connects, so the token is never written. */
const AUTHORIZATION = "Bearer ${DRAFT_MCP_TOKEN}";

/**
 * Adds Draft's tool server to the user scope of a Claude Code config file, keeping every other entry.
 * Throws when the file is not a JSON object, so a user's config is never overwritten.
 */
export function writeDraftMcpConfig(path: string, url: string): void {
  const config = readConfig(path);
  const servers = config.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`${path} has an mcpServers value that is not an object`);
  }
  config.mcpServers = { ...servers, draft: { type: "http", url, headers: { Authorization: AUTHORIZATION } } };
  const tmpPath = `${path}.draft-${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}
