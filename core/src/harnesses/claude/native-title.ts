import type { IncomingLine } from "./live-lines";

const ROOT_FILE = "root.jsonl";

/**
 * Claude Code's own title for the session, from the root transcript lines. A `/rename`
 * (custom-title) beats the generated one (ai-title); within each, the last record wins.
 */
export function latestNativeTitle(lines: IncomingLine[], maxChars: number): string | null {
  let custom: string | null = null;
  let generated: string | null = null;
  for (const line of lines) {
    if (!("raw" in line) || line.file !== ROOT_FILE || !line.raw.includes("-title")) continue;
    let record: { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
    try {
      record = JSON.parse(line.raw);
    } catch {
      continue;
    }
    if (record.type === "custom-title") custom = cleanTitle(record.customTitle) ?? custom;
    else if (record.type === "ai-title") generated = cleanTitle(record.aiTitle) ?? generated;
  }
  const title = custom ?? generated;
  return title ? title.slice(0, maxChars) : null;
}

function cleanTitle(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
