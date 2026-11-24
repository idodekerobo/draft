/**
 * What the sandbox runner must do for one run. The backend derives it from the AgentRunSpec,
 * and the runner builds the harness command from it. It holds no login: the harness gets its
 * environment from nothing, so the signed upload links below never reach the agent.
 * This file has no dependencies, so the backend and the runner bundle can both use it.
 */
import { cloudNativeToolsFor } from "./run-spec";

/** Every reasoning effort any harness offers, lowest first. A model offers some of them. */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const RUNNER_INPUT_ROOT = "/run/input";
export const PROMPT_FILE = `${RUNNER_INPUT_ROOT}/prompt.md`;
export const OUTPUT_SCHEMA_FILE = `${RUNNER_INPUT_ROOT}/output-schema.json`;

export const MODEL_PATTERN = /^[A-Za-z0-9._:\-\[\]]{1,100}$/;

export interface RunnerManifest {
  version: 1;
  harness: "claude" | "codex";
  model: string | null;
  /** Left out when the harness decides. An image built before efforts existed refuses a manifest that has this key. */
  reasoningEffort?: ReasoningEffort;
  prompt: { kind: "file"; path: string } | { kind: "items"; manifestPath: string };
  tools: { native: string[]; draftMcpUrl: string | null };
  output: { kind: "stream" } | { kind: "structured"; schemaPath: string };
  timeoutSeconds: number;
  network: "open" | "restricted";
  /**
   * Signed links where a routine run's session file and its metadata are uploaded at the end. Left out when the
   * run keeps no session file. Only a stream run has one.
   */
  sessionUpload?: { fileUrl: string; metadataUrl: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`run manifest: ${label} must be an object`);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new Error(`run manifest: unknown key in ${label}: ${extra}`);
  return value;
}

function pathUnder(path: unknown, label: string, inputRoot: string): string {
  const inside = typeof path === "string" && path.startsWith(`${inputRoot}/`) && !path.split("/").some((part) => part === ".." || part === ".");
  if (!inside) throw new Error(`run manifest: ${label} must be a file under ${inputRoot}`);
  return path as string;
}

/** A signed upload link. It must be HTTPS and carry no login of its own. */
function checkedUploadUrl(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new Error(`run manifest: ${label} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`run manifest: ${label} must be an HTTPS URL with no login`);
  return url.toString();
}

/** The tool server URL of a run. It must be HTTPS on the callback's host, with no login in it. */
export function checkedMcpUrl(value: string, callbackUrl: string): string {
  const url = new URL(value);
  const callback = new URL(callbackUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.host !== callback.host) {
    throw new Error("DRAFT_MCP_URL must be an HTTPS URL on the callback host");
  }
  return url.toString();
}

export interface ManifestChecks {
  callbackUrl: string;
  inputRoot?: string;
}

/** Checks a manifest strictly. Anything unknown is refused, because these values reach a command line. */
export function validateRunnerManifest(value: unknown, checks: ManifestChecks): RunnerManifest {
  const inputRoot = checks.inputRoot ?? RUNNER_INPUT_ROOT;
  const top = onlyKeys(value, ["version", "harness", "model", "reasoningEffort", "prompt", "tools", "output", "timeoutSeconds", "network", "sessionUpload"], "manifest");
  if (top.version !== 1) throw new Error("run manifest: version must be 1");
  if (top.harness !== "claude" && top.harness !== "codex") throw new Error("run manifest: harness must be claude or codex");
  const harness = top.harness;
  if (top.model !== null && (typeof top.model !== "string" || !MODEL_PATTERN.test(top.model))) throw new Error("run manifest: model is invalid");
  if (top.reasoningEffort !== undefined && !(REASONING_EFFORTS as ReadonlyArray<unknown>).includes(top.reasoningEffort)) throw new Error("run manifest: reasoningEffort is invalid");
  if (typeof top.timeoutSeconds !== "number" || !Number.isSafeInteger(top.timeoutSeconds) || top.timeoutSeconds < 1 || top.timeoutSeconds > 7200) {
    throw new Error("run manifest: timeoutSeconds must be between 1 and 7200");
  }
  const network = top.network === undefined ? "restricted" : top.network;
  if (network !== "open" && network !== "restricted") throw new Error("run manifest: network must be open or restricted");

  const promptValue = isObject(top.prompt) ? top.prompt : null;
  let prompt: RunnerManifest["prompt"];
  if (promptValue?.kind === "file") {
    prompt = { kind: "file", path: pathUnder(onlyKeys(promptValue, ["kind", "path"], "prompt").path, "prompt.path", inputRoot) };
  } else if (promptValue?.kind === "items") {
    prompt = { kind: "items", manifestPath: pathUnder(onlyKeys(promptValue, ["kind", "manifestPath"], "prompt").manifestPath, "prompt.manifestPath", inputRoot) };
  } else {
    throw new Error("run manifest: prompt.kind must be file or items");
  }

  const toolsValue = onlyKeys(top.tools, ["native", "draftMcpUrl"], "tools");
  const allowedNative = cloudNativeToolsFor(harness);
  if (!Array.isArray(toolsValue.native) || !toolsValue.native.every((tool) => typeof tool === "string" && allowedNative.includes(tool))) {
    throw new Error("run manifest: tools.native has a tool this harness may not use");
  }
  if (toolsValue.draftMcpUrl !== null && typeof toolsValue.draftMcpUrl !== "string") throw new Error("run manifest: tools.draftMcpUrl must be a string or null");
  const tools = {
    native: [...new Set(toolsValue.native as string[])],
    draftMcpUrl: toolsValue.draftMcpUrl === null ? null : checkedMcpUrl(toolsValue.draftMcpUrl as string, checks.callbackUrl),
  };

  const outputValue = isObject(top.output) ? top.output : null;
  let output: RunnerManifest["output"];
  if (outputValue?.kind === "stream") {
    onlyKeys(outputValue, ["kind"], "output");
    output = { kind: "stream" };
  } else if (outputValue?.kind === "structured") {
    output = { kind: "structured", schemaPath: pathUnder(onlyKeys(outputValue, ["kind", "schemaPath"], "output").schemaPath, "output.schemaPath", inputRoot) };
  } else {
    throw new Error("run manifest: output.kind must be stream or structured");
  }

  if (prompt.kind === "items" && output.kind !== "structured") throw new Error("run manifest: items need structured output");
  let sessionUpload: RunnerManifest["sessionUpload"];
  if (top.sessionUpload !== undefined) {
    if (output.kind !== "stream") throw new Error("run manifest: only a stream run keeps a session file");
    const upload = onlyKeys(top.sessionUpload, ["fileUrl", "metadataUrl"], "sessionUpload");
    sessionUpload = { fileUrl: checkedUploadUrl(upload.fileUrl, "sessionUpload.fileUrl"), metadataUrl: checkedUploadUrl(upload.metadataUrl, "sessionUpload.metadataUrl") };
  }
  return {
    version: 1,
    harness,
    model: top.model as string | null,
    ...(top.reasoningEffort !== undefined ? { reasoningEffort: top.reasoningEffort as ReasoningEffort } : {}),
    prompt,
    tools,
    output,
    timeoutSeconds: top.timeoutSeconds,
    network,
    ...(sessionUpload ? { sessionUpload } : {}),
  };
}

export function parseRunnerManifest(raw: string, checks: ManifestChecks): RunnerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("run manifest: DRAFT_RUN_MANIFEST must contain valid JSON");
  }
  return validateRunnerManifest(parsed, checks);
}
