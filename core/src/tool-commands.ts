import type { DraftToolName } from "./tools";

/**
 * The CLI command that reaches each Draft tool, as the words after `draft`. A tool the CLI leaves out is null:
 * either it is plumbing for agent runs, or it is a known gap listed in PARITY_GAPS. A backend test holds the MCP
 * and this list to the same set of tools.
 */
export const TOOL_COMMANDS: Record<DraftToolName, string | null> = {
  "context.read": "context read",
  "context.write": null,
  "context.list": "context list",
  "context.export": "context export",
  "sources.search": "sources search",
  "sources.list": "sources list",
  "sources.read": "sources read",
  "sessions.list": "sessions list",
  "sessions.read": "sessions read",
  "skills.list": "skills list",
  "skills.read": "skills read",
  "skills.add": "skills add",
  "skills.update": "skills update",
  "skills.delete": "skills remove",
  "routines.list": "routines list",
  "routines.create": "routines create",
  "routines.update": "routines update",
  "routines.delete": "routines delete",
  "routines.run": "routines run",
  "routines.runs": "routines runs",
  "routines.options": "routines options",
  "connections.list": "connections list",
  "connections.connect": "connections connect",
  "connections.disconnect": "connections disconnect",
  "connections.join": "connections join",
  "connections.leave": "connections leave",
  "connections.read": "connections read",
  "connections.post": "connections post",
  "activity.list": "activity list",
  "github.credential": null,
  "people.find": "people find",
  "people.create": "people create",
  "people.update": "people update",
  "people.notify": "people notify",
  "people.approve": "people approve",
  "people.reject": "people reject",
};

/**
 * Where the MCP and the CLI disagree today. Each entry is a gap to close or a decision to make. The parity test
 * fails when a tool disagrees and is not listed here, and when a listed tool no longer disagrees.
 */
export const PARITY_GAPS: Partial<Record<DraftToolName, string>> = {};
