import type { SeedSpec } from "../sandbox/host/config";

/** Hosts a cloud session may reach besides its model provider, the API and the storage host. */
export const CLOUD_EGRESS_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "api.anthropic.com",
] as const;


export interface CloudSandboxEnvInput {
  sessionId: string;
  workspaceId: string;
  runId: string;
  /** The host's token. The host removes it from the agent's environment before the agent starts. */
  runToken: string;
  /** The agent's token. It can call Draft tools but not the host endpoints, so the agent may keep it. */
  mcpToken: string;
  claudeToken: string;
  /** What the host fetches. A snapshot carries a short-lived download link, so this value is secret too. */
  seed: SeedSpec;
  network: "restricted" | "open";
  /** The deployment's callback URL. Only its origin is the API base. */
  callbackUrl: string;
  supabaseUrl: string;
}

/** The environment of a cloud session's sandbox. It holds the run's secrets, so callers must never log it. */
export function cloudSandboxEnv(input: CloudSandboxEnvInput): Record<string, string> {
  const apiBase = new URL(input.callbackUrl).origin;
  const hosts = [...new Set([...CLOUD_EGRESS_HOSTS, new URL(apiBase).hostname, new URL(input.supabaseUrl).hostname])];
  return {
    DRAFT_MODE: "host",
    DRAFT_SESSION_ID: input.sessionId,
    DRAFT_WORKSPACE_ID: input.workspaceId,
    DRAFT_RUN_ID: input.runId,
    DRAFT_RUN_TOKEN: input.runToken,
    DRAFT_API_BASE_URL: apiBase,
    DRAFT_MCP_URL: new URL(`/runs/${input.runId}/mcp`, apiBase).toString(),
    DRAFT_MCP_TOKEN: input.mcpToken,
    CLAUDE_CODE_OAUTH_TOKEN: input.claudeToken,
    DRAFT_SEED: JSON.stringify(input.seed),
    DRAFT_NETWORK: input.network,
    DRAFT_EGRESS_HOSTS: hosts.join(","),
  };
}
