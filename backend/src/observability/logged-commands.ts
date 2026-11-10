/** The command names the agent_query_log table accepts (its check constraint lists the same names). */
export const LOGGED_COMMANDS = [
  "context.read",
  "sessions.list",
  "sessions.read",
  "sessions.search",
  "skills.list",
  "skills.read",
  "sources.search",
  "sources.read",
  "routines.list",
  "mcp.context.list",
  "mcp.context.read",
  "mcp.sessions.list",
  "mcp.sessions.read",
  "mcp.sessions.search",
  "mcp.skills.list",
  "mcp.skills.read",
  "mcp.skills.add",
  "mcp.sources.search",
  "mcp.sources.read",
  "context.export",
  "mcp.context.export",
  "mcp.routines.list",
] as const;

export type AgentQueryLogCommand = (typeof LOGGED_COMMANDS)[number];

const LOGGED: ReadonlySet<string> = new Set(LOGGED_COMMANDS);

/** The log table accepts only these names. A call under any other name (a CLI skill write, say) is not logged. */
export function isLoggedCommand(command: string): command is AgentQueryLogCommand {
  return LOGGED.has(command);
}
