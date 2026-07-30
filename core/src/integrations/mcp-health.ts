export type McpServerState = "connected" | "unavailable";

export interface McpServerHealth {
  id: string;
  state: McpServerState;
  message: string | null;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function sanitizeMcpMessage(message: string): string {
  return message
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(\b(?:api[_-]?key|token)=)[^\s&]+/gi, "$1[redacted]")
    .trim()
    .slice(0, 500);
}

export function parseClaudeMcpList(output: string): McpServerHealth[] {
  const servers: McpServerHealth[] = [];
  for (const rawLine of output.replace(ANSI_PATTERN, "").split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    if (separator <= 0) continue;
    const id = rawLine.slice(0, separator).trim();
    const detail = rawLine.slice(separator + 1).trim();
    if (!id || !detail) continue;
    if (/(?:✔|✓)\s*Connected\b/i.test(detail)) {
      servers.push({ id, state: "connected", message: null });
      continue;
    }
    if (/(?:✘|×)\s*Failed\b/i.test(detail)) {
      const reasonSeparator = detail.lastIndexOf("—");
      const message = sanitizeMcpMessage(reasonSeparator >= 0 ? detail.slice(reasonSeparator + 1) : "Failed to connect");
      servers.push({ id, state: "unavailable", message });
    }
  }
  return servers;
}

export function findMcpServer(output: string, id: string): McpServerHealth | null {
  return parseClaudeMcpList(output).find(server => server.id === id) ?? null;
}

export function selectConnectedMcpServer(output: string, preferredIds: readonly string[]): McpServerHealth | null {
  const servers = parseClaudeMcpList(output);
  for (const id of preferredIds) {
    const match = servers.find(server => server.id === id && server.state === "connected");
    if (match) return match;
  }
  return null;
}
