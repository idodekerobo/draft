/** The hosted MCP endpoint lives at /mcp on the API base URL. */
export function mcpUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/mcp`;
}

/** Setup snippets from docs/mcp.md. */
export function mcpSetupSnippets(url: string): Array<{ agent: string; hint: string; snippet: string }> {
  return [
    { agent: "Claude Code", hint: "Run in a terminal", snippet: `claude mcp add --transport http draft ${url}` },
    { agent: "Codex", hint: "Add to ~/.codex/config.toml", snippet: `[mcp_servers.draft]\nurl = "${url}"` },
  ];
}
