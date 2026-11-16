import { existsSync, readFileSync } from "fs";
import { modelLabel } from "draft-core/harnesses";

/** What a harness uses on this computer when a session asks for "Default". Both are null when the setting is not there. */
export interface AgentDefaults {
  /** The model's alias as the harness's own setting names it, such as "sonnet". */
  model: string | null;
  /** How to show the model, such as "Sonnet 5.5". */
  modelLabel: string | null;
  effort: string | null;
}

const EMPTY: AgentDefaults = { model: null, modelLabel: null, effort: null };

/** "claude-sonnet-5-5" is "Sonnet 5.5". Anything that does not look like that gives null. */
export function claudeModelName(id: string): string | null {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(id);
  return match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]!.replace("-", ".")}` : null;
}

/** Reads Claude's saved model and the effort saved for it. `settings` is the parsed ~/.claude/settings.json. */
export function claudeDefaultsFrom(settings: unknown): AgentDefaults {
  if (!settings || typeof settings !== "object") return EMPTY;
  const { model, effortLevel, modelSettings } = settings as { model?: unknown; effortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown } | undefined> };
  if (typeof model !== "string" || !model) return EMPTY;
  // The saved effort is kept per full model id. The newest id that contains the alias is the one the alias means.
  const id = Object.keys(modelSettings ?? {}).filter((key) => key.includes(model)).sort().at(-1);
  const saved = id ? modelSettings?.[id]?.effortLevel : undefined;
  const effort = typeof saved === "string" ? saved : typeof effortLevel === "string" ? effortLevel : null;
  return { model, modelLabel: (id && claudeModelName(id)) ?? modelLabel("claude", model), effort };
}

/** Reads the top-level `model` and `model_reasoning_effort` of a Codex config.toml. */
export function codexDefaultsFrom(toml: string): AgentDefaults {
  const top = toml.split(/^\s*\[/m)[0] ?? "";
  const read = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(top)?.[1] ?? null;
  const model = read("model");
  return { model, modelLabel: model ? modelLabel("codex", model) : null, effort: read("model_reasoning_effort") };
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function readAgentDefaults(harness: string, home = process.env.HOME ?? ""): AgentDefaults {
  if (harness === "claude") {
    const text = readText(`${home}/.claude/settings.json`);
    try {
      return text ? claudeDefaultsFrom(JSON.parse(text)) : EMPTY;
    } catch {
      return EMPTY;
    }
  }
  if (harness === "codex") {
    const text = readText(`${process.env.CODEX_HOME ?? `${home}/.codex`}/config.toml`);
    return text ? codexDefaultsFrom(text) : EMPTY;
  }
  return EMPTY;
}
