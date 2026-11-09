import { z } from "zod";
import type { AgentRunSpec } from "draft-core/agent-run";

/**
 * What the sandbox runner must do for one run. The backend derives it from the AgentRunSpec in
 * buildRunnerManifest, and the runner builds the harness command from it. It holds no secret.
 * The runner is built apart from the backend and keeps its own parser for this shape;
 * a test holds the two together.
 */
export const RUNNER_INPUT_ROOT = "/run/input";
export const PROMPT_FILE = `${RUNNER_INPUT_ROOT}/prompt.md`;
export const OUTPUT_SCHEMA_FILE = `${RUNNER_INPUT_ROOT}/output-schema.json`;

const underInput = z.string().refine((path) => path.startsWith(`${RUNNER_INPUT_ROOT}/`) && !path.includes(".."), "must be a file under /run/input");

export const runnerManifestSchema = z
  .object({
    version: z.literal(1),
    harness: z.enum(["claude", "codex"]),
    model: z.string().regex(/^[A-Za-z0-9._:\-\[\]]{1,100}$/).nullable(),
    prompt: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), path: underInput }).strict(),
      z.object({ kind: z.literal("items"), manifestPath: underInput }).strict(),
    ]),
    tools: z.object({ native: z.array(z.string()), draftMcpUrl: z.string().url().nullable() }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("stream") }).strict(),
      z.object({ kind: z.literal("structured"), schemaPath: underInput }).strict(),
    ]),
    timeoutSeconds: z.number().int().min(1).max(3600),
  })
  .strict();

export type RunnerManifest = z.infer<typeof runnerManifestSchema>;

export type PromptSource = { kind: "text"; text: string } | { kind: "items"; manifestPath: string };

export interface BuildRunnerManifestInput {
  spec: AgentRunSpec;
  prompt: PromptSource;
  timeoutSeconds: number;
  /** The tool server's URL, or null for a run with no Draft tools. */
  draftMcpUrl: string | null;
}

/** True when the run needs Draft's tool server: it holds a Draft tool or a connection. */
export function needsDraftToolServer(spec: AgentRunSpec): boolean {
  return spec.permissions.length > 0 || (spec.runtime.type === "cloud" && spec.runtime.environment.mcpServers.length > 0);
}

/** The one place a spec becomes what the sandbox does. Identity, tools and permissions reach every run through here. */
export function buildRunnerManifest(input: BuildRunnerManifestInput): RunnerManifest {
  const { spec } = input;
  if (spec.runtime.type !== "cloud") throw new Error("A sandbox run needs a cloud runtime");
  if (spec.output.type === "none") throw new Error("A sandbox run needs a text or structured output");
  if (spec.harness === "codex" && (spec.output.type !== "text" || input.prompt.kind !== "text")) {
    throw new Error("A Codex run streams text from a single prompt");
  }
  const native = spec.runtime.environment.nativeTools.filter((tool) => tool.harness === spec.harness).map((tool) => tool.tool as string);
  // The caller names the items file relative to the bundle. The runner reads it from /run.
  const itemsPath = input.prompt.kind === "items" ? (input.prompt.manifestPath.startsWith("/") ? input.prompt.manifestPath : `/run/${input.prompt.manifestPath}`) : "";

  const manifest: RunnerManifest = {
    version: 1,
    harness: spec.harness,
    model: spec.model,
    prompt: input.prompt.kind === "text" ? { kind: "file", path: PROMPT_FILE } : { kind: "items", manifestPath: itemsPath },
    tools: { native, draftMcpUrl: input.draftMcpUrl },
    output: spec.output.type === "text" ? { kind: "stream" } : { kind: "structured", schemaPath: OUTPUT_SCHEMA_FILE },
    timeoutSeconds: input.timeoutSeconds,
  };
  return runnerManifestSchema.parse(manifest);
}

/**
 * The environment variables the runner used before it read a manifest. They are still set, so an image
 * that has not been replaced keeps working. Remove them once every environment runs a manifest-reading image.
 */
export function legacyRunnerEnv(manifest: RunnerManifest): Record<string, string> {
  const env: Record<string, string> = {};
  if (manifest.harness === "codex") env.DRAFT_RUN_HARNESS = "codex";
  if (manifest.output.kind === "structured") env.DRAFT_OUTPUT_SCHEMA_PATH = manifest.output.schemaPath;
  if (manifest.prompt.kind === "items") {
    env.DRAFT_RUN_MODE = "batch";
    env.DRAFT_MANIFEST_PATH = manifest.prompt.manifestPath;
  }
  if (manifest.output.kind === "stream") {
    env.DRAFT_RUN_MODE = "routine";
    if (manifest.model) env.DRAFT_ROUTINE_MODEL = manifest.model;
    env.DRAFT_NATIVE_TOOLS = manifest.tools.native.join(",");
    if (manifest.tools.draftMcpUrl) env.DRAFT_MCP_URL = manifest.tools.draftMcpUrl;
  }
  return env;
}
