export type Platform = "web" | "desktop";
export type ToolId = "fireflies" | "granola" | "claude-code" | "slack" | "github" | "linear" | "coding-sessions";
/** "sessions" is omitted from the onboarding group lists, which keep their current tools. */
export type ToolGroup = "meetings" | "agent" | "team" | "sessions";
/** Page headings. Data flowing into Draft, and Draft feeding an agent. */
export type ToolSection = "sources" | "agent";

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
  { id: "coding-sessions", name: "Coding sessions", description: "Captures finished Claude Code sessions from your repos", group: "sessions", scope: "workspace", platforms: ["web", "desktop"], popularity: 50 },
];

const GROUP_ORDER: ToolGroup[] = ["meetings", "agent", "team", "sessions"];

export const SECTIONS: Array<{ id: ToolSection; label: string; groups: ToolGroup[] }> = [
  { id: "sources", label: "Sources", groups: ["meetings", "team", "sessions"] },
  { id: "agent", label: "Use Draft in your agent", groups: ["agent"] },
];

export type ToolState = "connected" | "pending" | "error" | "disconnected";

export interface ToolStatus {
  state: ToolState;
  /** Account name when connected (for example "cedar-frame-studio"), otherwise status text. */
  detail?: string | null;
}

export function toolsForPlatform(platform: Platform, groups: ToolGroup[] = GROUP_ORDER): ToolEntry[] {
  return TOOL_REGISTRY.filter((tool) => tool.platforms.includes(platform) && groups.includes(tool.group));
}

/** Groups tools under the page sections. Within a section, connected tools come first, then by popularity. */
export function groupTools(tools: ToolEntry[], statuses: Partial<Record<ToolId, ToolStatus>>): Array<{ section: ToolSection; label: string; tools: ToolEntry[] }> {
  const rank = (tool: ToolEntry) => (statuses[tool.id]?.state === "connected" ? 0 : 1);
  return SECTIONS.flatMap(({ id, label, groups }) => {
    const inSection = tools
      .filter((tool) => groups.includes(tool.group))
      .sort((a, b) => rank(a) - rank(b) || b.popularity - a.popularity);
    return inSection.length ? [{ section: id, label, tools: inSection }] : [];
  });
}
