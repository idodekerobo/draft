import { MODEL_PATTERN, parseRunnerManifest, validateRunnerManifest, type RunnerManifest } from "draft-core/run-manifest";

const DEFAULT_PROMPT_PATH = "/run/input/prompt.md";
const DEFAULT_OUTPUT_SCHEMA_PATH = "/run/input/output-schema.json";
const DEFAULT_CLAUDE_TOOLS = ["Read", "Glob"];

export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 300;
  if (!/^\d+$/.test(raw)) throw new Error("DRAFT_TIMEOUT_SECONDS must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600) {
    throw new Error("DRAFT_TIMEOUT_SECONDS must be between 1 and 3600");
  }
  return value;
}

/** The manifest an older backend implies through its environment variables. Kept until every environment sends a manifest. */
export function manifestFromLegacyEnv(env: NodeJS.ProcessEnv, callbackUrl: string, inputRoot = "/run/input"): RunnerManifest {
  const harness = env.DRAFT_RUN_HARNESS === "codex" ? "codex" : "claude";
  const mode = env.DRAFT_RUN_MODE === "batch" || env.DRAFT_RUN_MODE === "routine" ? env.DRAFT_RUN_MODE : "single";
  const nativeNamed = mode === "routine" && env.DRAFT_NATIVE_TOOLS ? env.DRAFT_NATIVE_TOOLS.split(",").map((tool) => tool.trim()).filter(Boolean) : null;
  if (mode === "batch" && !env.DRAFT_MANIFEST_PATH) throw new Error("DRAFT_MANIFEST_PATH is required");
  return validateRunnerManifest(
    {
      version: 1,
      harness,
      model: mode === "routine" ? env.DRAFT_ROUTINE_MODEL || null : null,
      prompt: mode === "batch" ? { kind: "items", manifestPath: env.DRAFT_MANIFEST_PATH } : { kind: "file", path: env.DRAFT_PROMPT_PATH || DEFAULT_PROMPT_PATH },
      tools: {
        native: nativeNamed ?? (harness === "claude" ? [...DEFAULT_CLAUDE_TOOLS] : ["shell"]),
        draftMcpUrl: mode === "routine" && env.DRAFT_MCP_URL ? env.DRAFT_MCP_URL : null,
      },
      output: mode === "routine" ? { kind: "stream" } : { kind: "structured", schemaPath: env.DRAFT_OUTPUT_SCHEMA_PATH || DEFAULT_OUTPUT_SCHEMA_PATH },
      timeoutSeconds: parseTimeoutSeconds(env.DRAFT_TIMEOUT_SECONDS),
    },
    { callbackUrl, inputRoot },
  );
}

export function loadRunnerManifest(env: NodeJS.ProcessEnv, callbackUrl: string): RunnerManifest {
  return env.DRAFT_RUN_MANIFEST ? parseRunnerManifest(env.DRAFT_RUN_MANIFEST, { callbackUrl }) : manifestFromLegacyEnv(env, callbackUrl);
}
