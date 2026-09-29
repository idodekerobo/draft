export type Platform = "web" | "desktop";
export type ToolId = "fireflies" | "granola" | "claude-code" | "slack" | "github" | "linear" | "coding-sessions";
export type ToolGroup = "meetings" | "agent" | "team" | "computer";

export interface ToolEntry {
  id: ToolId;
  name: string;
  description: string;
  group: ToolGroup;
  scope: "personal" | "workspace";
  platforms: Platform[];
  /** Higher sorts first among tools with the same status. */
  popularity: number;
}

export const TOOL_REGISTRY: ToolEntry[] = [
  { id: "fireflies", name: "Fireflies", description: "Meeting notes from your Fireflies account", group: "meetings", scope: "personal", platforms: ["web", "desktop"], popularity: 80 },
  { id: "granola", name: "Granola", description: "Meeting notes from your Granola account", group: "meetings", scope: "personal", platforms: ["web", "desktop"], popularity: 60 },
  { id: "claude-code", name: "Claude Code, Codex or Cursor", description: "Gives your agent your team's context", group: "agent", scope: "personal", platforms: ["web", "desktop"], popularity: 100 },
  { id: "slack", name: "Slack", description: "Reads the channels you choose", group: "team", scope: "workspace", platforms: ["web", "desktop"], popularity: 100 },
  { id: "github", name: "GitHub", description: "Reads pull requests and commits", group: "team", scope: "workspace", platforms: ["web", "desktop"], popularity: 90 },
  { id: "linear", name: "Linear", description: "Reads issues and projects", group: "team", scope: "workspace", platforms: ["web", "desktop"], popularity: 70 },
  { id: "coding-sessions", name: "Coding sessions", description: "Captures finished Claude Code sessions from a folder", group: "computer", scope: "personal", platforms: ["desktop"], popularity: 50 },
];

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  meetings: "Your meetings",
  agent: "Your AI agent",
  team: "Connected for your team",
  computer: "On this computer",
};

const GROUP_ORDER: ToolGroup[] = ["meetings", "agent", "team", "computer"];

export type ToolState = "connected" | "pending" | "error" | "disconnected";

export interface ToolStatus {
  state: ToolState;
  /** Account name when connected (for example "cedar-frame-studio"), otherwise status text. */
  detail?: string | null;
}

export function toolsForPlatform(platform: Platform, groups: ToolGroup[] = GROUP_ORDER): ToolEntry[] {
  return TOOL_REGISTRY.filter((tool) => tool.platforms.includes(platform) && groups.includes(tool.group));
}

/** Groups tools in display order. Within a group, connected tools come first, then by popularity. */
export function groupTools(tools: ToolEntry[], statuses: Partial<Record<ToolId, ToolStatus>>): Array<{ group: ToolGroup; label: string; tools: ToolEntry[] }> {
  const rank = (tool: ToolEntry) => (statuses[tool.id]?.state === "connected" ? 0 : 1);
  return GROUP_ORDER.flatMap((group) => {
    const inGroup = tools
      .filter((tool) => tool.group === group)
      .sort((a, b) => rank(a) - rank(b) || b.popularity - a.popularity);
    return inGroup.length ? [{ group, label: TOOL_GROUP_LABELS[group], tools: inGroup }] : [];
  });
}
