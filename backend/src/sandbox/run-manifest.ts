import type { AgentRunSpec } from "draft-core/run-spec";
import { OUTPUT_SCHEMA_FILE, PROMPT_FILE, validateRunnerManifest, type RunnerManifest } from "draft-core/run-manifest";

export type PromptSource = { kind: "text"; text: string } | { kind: "items"; manifestPath: string };

export interface BuildRunnerManifestInput {
  spec: AgentRunSpec;
  /** The URL the runner posts back to. The tool server must sit on its host. */
  callbackUrl: string;
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
  return validateRunnerManifest(manifest, { callbackUrl: input.callbackUrl });
}
