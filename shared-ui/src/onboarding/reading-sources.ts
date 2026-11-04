import type { ToolId, ToolStatus } from "../integrations/registry";
import type { ReadingSource } from "./first-user";

const READING_TOOLS = [
  ["slack", "Slack"],
  ["github", "GitHub"],
  ["linear", "Linear"],
  ["fireflies", "Fireflies"],
  ["granola", "Granola"],
] as const;

/** Lists the tools Draft is reading from: every connected, pending or errored one, plus an imported folder. */
export function buildReadingSources(
  statuses: Partial<Record<ToolId, ToolStatus>>,
  options: { details?: Partial<Record<ToolId, string>>; folderImported?: boolean } = {},
): ReadingSource[] {
  const sources: ReadingSource[] = [];
  for (const [id, name] of READING_TOOLS) {
    const status = statuses[id];
    if (!status || status.state === "disconnected") continue;
    sources.push({ name, status, detail: options.details?.[id] });
  }
  if (options.folderImported) {
    sources.push({ name: "Folder", status: { state: "connected" }, detail: "Uploaded from this computer" });
  }
  return sources;
}
