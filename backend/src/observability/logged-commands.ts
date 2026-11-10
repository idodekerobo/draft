import type { AgentQueryLogCommand } from "./record-query-log";

const LOGGED_COMMANDS: ReadonlySet<string> = new Set<AgentQueryLogCommand>([
  "context.read", "sessions.list", "sessions.read", "sessions.search", "skills.list", "skills.read", "sources.search", "sources.read",
  "routines.list", "mcp.context.list", "mcp.context.read", "mcp.sessions.list", "mcp.sessions.read", "mcp.sessions.search",
  "mcp.skills.list", "mcp.skills.read", "mcp.skills.add", "mcp.sources.search", "mcp.sources.read", "context.export",
  "mcp.context.export", "mcp.routines.list",
]);

/** The log table accepts only these names. A call under any other name (a CLI skill write, say) is not logged. */
export function isLoggedCommand(command: string): command is AgentQueryLogCommand {
  return LOGGED_COMMANDS.has(command);
}
