import { AI_TOOL_CODES, PROFILE_VERSION, ROLE_CODES, TEAM_SIZE_CODES } from "./questions";

const MAX_NAME_LENGTH = 100;
const MAX_SHORT_TEXT_LENGTH = 200;
const MAX_LONG_TEXT_LENGTH = 1000;

const LEGACY_KEYS = ["how_heard", "use_case", "team_size"] as const;

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, maxLength) || null;
}

function code(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

// Accepts an array or a comma-separated string; stores known codes only, comma-separated.
function codeList(value: unknown, allowed: readonly string[]): string | null {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const kept = [...new Set(items.map((item) => (typeof item === "string" ? item.trim() : "")))].filter((item) =>
    allowed.includes(item),
  );
  return kept.length > 0 ? kept.join(",") : null;
}

// Payloads without profile_version "2" come from the old free-text form.
export function cleanProfile(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof input !== "object" || input === null) return result;
  const raw = input as Record<string, unknown>;

  if (raw.profile_version !== PROFILE_VERSION) {
    for (const key of LEGACY_KEYS) {
      const value = text(raw[key], MAX_LONG_TEXT_LENGTH);
      if (value) result[key] = value;
    }
    return result;
  }

  const fields: Record<string, string | null> = {
    name: text(raw.name, MAX_NAME_LENGTH),
    role: code(raw.role, ROLE_CODES),
    team_size: code(raw.team_size, TEAM_SIZE_CODES),
    ai_tools: codeList(raw.ai_tools, AI_TOOL_CODES),
    use_case: text(raw.use_case, MAX_LONG_TEXT_LENGTH),
    how_heard: text(raw.how_heard, MAX_SHORT_TEXT_LENGTH),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value) result[key] = value;
  }
  if (Object.keys(result).length > 0) result.profile_version = PROFILE_VERSION;
  return result;
}
