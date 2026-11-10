// Trusted one-shot sandbox lifecycle and callback runner.
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROMPT_PATH = "/run/input/prompt.md";
const DEFAULT_OUTPUT_SCHEMA_PATH = "/run/input/output-schema.json";
const OUTPUT_PATH = "/run/output/result.json";
const SCRATCH_STDOUT_PATH = "/run/scratch/claude.stdout.json";
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const AGENT_UID = 1000;
const AGENT_GID = 1000;

export interface ClaudeEnvelope {
  type: "result";
  result?: unknown;
  structured_output?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export type ClaudeFailureCategory =
  | "none"
  | "auth"
  | "rate_limit"
  | "permission"
  | "network"
  | "other";

export type RunnerFailureCode =
  | "timeout"
  | "output_too_large"
  | "claude_error"
  | "claude_exit"
  | "codex_error"
  | "codex_exit"
  | "incomplete_result"
  | "bundle_fetch_failed"
  | "runner_error";

export interface FinalDiagnosticInput {
  timedOut: boolean;
  overflow: boolean;
  envelopeFound: boolean;
  envelopeIsError: boolean;
  payloadValid: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  failureCategory: ClaudeFailureCategory;
}

export interface SafeFailureDiagnostics extends FinalDiagnosticInput {
  failureCode: RunnerFailureCode;
}

export function classifyClaudeFailureChunk(
  chunk: string,
  current: ClaudeFailureCategory = "none",
): ClaudeFailureCategory {
  if (current !== "none" && current !== "other") return current;
  const text = chunk.toLowerCase();
  if (/oauth|unauth|invalid api key|authenticat/.test(text)) return "auth";
  if (/rate.?limit|too many requests|\b429\b/.test(text)) return "rate_limit";
  if (/permission|not allowed|access denied|\b403\b/.test(text)) return "permission";
  if (/network|econn|enotfound|dns|socket|timed? ?out/.test(text)) return "network";
  return text.trim() ? "other" : current;
}

export function classifyClaudeEnvelopeFailure(
  envelope: ClaudeEnvelope | null,
  current: ClaudeFailureCategory = "none",
): ClaudeFailureCategory {
  if (envelope?.is_error !== true || typeof envelope.result !== "string") return current;
  return classifyClaudeFailureChunk(envelope.result, current);
}

export function buildFailureDiagnostics(
  input: FinalDiagnosticInput,
): SafeFailureDiagnostics | null {
  if (input.payloadValid) return null;
  const failureCode: RunnerFailureCode = input.timedOut
    ? "timeout"
    : input.overflow
      ? "output_too_large"
      : input.envelopeIsError
        ? "claude_error"
        : input.exitCode !== 0 || input.signal !== null
          ? "claude_exit"
          : "incomplete_result";
  return { ...input, failureCode };
}

function runnerLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ source: "claude_runner", event, ...fields }));
}

export class CallbackDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackDeliveryError";
  }
}

// Failure reasons reach logs and the backend errors table, so strip anything
// that can carry a credential: the callback token, bearer values, signed URLs.
export function sanitizeReason(error: unknown, token = ""): string {
  let text = error instanceof Error ? error.message : String(error);
  if (token) text = text.split(token).join("[REDACTED]");
  text = text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1");
  return text.slice(0, 300);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCompletedClaudeEnvelope(raw: string): ClaudeEnvelope | null {
  const candidates = [raw.trim(), ...raw.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        isObject(parsed) &&
        parsed.type === "result" &&
        (Object.prototype.hasOwnProperty.call(parsed, "result") ||
          Object.prototype.hasOwnProperty.call(parsed, "structured_output"))
      ) {
        return parsed as ClaudeEnvelope;
      }
    } catch {
      // Streaming output can contain non-JSON progress lines or partial JSON.
    }
  }
  return null;
}

export function parseResultPayload(value: unknown): unknown | null {
  if (isObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractStructuredOutput(envelope: ClaudeEnvelope | null): unknown | null {
  if (envelope?.is_error === true) return null;
  return parseResultPayload(envelope?.structured_output);
}

export function sanitizedClaudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required");
  const allowed: Record<string, string> = {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: env.LANG || "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (env.TZ) allowed.TZ = env.TZ;
  if (env.DRAFT_RUN_TOKEN) allowed.DRAFT_RUN_TOKEN = env.DRAFT_RUN_TOKEN;
  return allowed;
}

const CODEX_HOME = "/home/agent/.codex";
const CODEX_AUTH_FILE = `${CODEX_HOME}/auth.json`;
const CODEX_CONFIG_FILE = `${CODEX_HOME}/config.toml`;
const CODEX_WORK_DIR = "/home/agent/work";

// Must match CLOUD_NATIVE_TOOLS in core. The runner is built apart from the backend, so it keeps its own copy,
// and a test holds the two together.
export const RUNNER_NATIVE_TOOLS = {
  claude: ["Read", "Glob", "Grep", "WebSearch"],
  codex: ["shell", "web_search"],
} as const;
const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const DEFAULT_CLAUDE_TOOLS = ["Read", "Glob"];

/** Draft's tool server for a Codex run. The bearer token comes from the environment, never from this file. */
export function codexConfigToml(options: { mcpUrl: string | null; webSearch: boolean }): string {
  // A top-level key must come before any table.
  return [...(options.webSearch ? ['web_search = "live"'] : []), ...(options.mcpUrl ? [codexMcpConfigToml(options.mcpUrl)] : [])].join("\n");
}

export function codexMcpConfigToml(mcpUrl: string): string {
  return [
    "[mcp_servers.draft]",
    `url = ${JSON.stringify(mcpUrl)}`,
    'bearer_token_env_var = "DRAFT_RUN_TOKEN"',
    "required = true",
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
}

/** Draft's tool server for a Claude Code run. The header reads the token from the environment. */
export function claudeMcpConfigJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { draft: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${DRAFT_RUN_TOKEN}" } } } });
}

/** The tool server URL of a run: unset means the run has no Draft tools. It must be HTTPS on the callback's host. */
export function routineMcpUrl(value: string | undefined, callbackUrl: string): string | null {
  if (!value) return null;
  const url = new URL(value);
  const callback = new URL(callbackUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.host !== callback.host) {
    throw new Error("DRAFT_MCP_URL must be an HTTPS URL on the callback host");
  }
  return url.toString();
}

export function sanitizedCodexEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed: Record<string, string> = {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: env.LANG || "C.UTF-8",
    CODEX_HOME,
  };
  if (env.TZ) allowed.TZ = env.TZ;
  if (env.DRAFT_RUN_TOKEN) allowed.DRAFT_RUN_TOKEN = env.DRAFT_RUN_TOKEN;
  return allowed;
}

/** The ids of the `agent` user. The base image gives id 1000 to `node`, so `agent` is 1001. Null when it is not listed. */
export function parseAgentIds(passwd: string): { uid: number; gid: number } | null {
  const fields = passwd.split("\n").find((line) => line.startsWith("agent:"))?.split(":");
  const uid = Number(fields?.[2]);
  const gid = Number(fields?.[3]);
  return fields && Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
}

/** Puts the workspace's login where Codex reads it, for the agent user alone. */
export function prepareCodexHome(authJson: string, mcpUrl: string | null = null, nativeTools: string[] | null = null): void {
  const { uid, gid } = parseAgentIds(readFileSync("/etc/passwd", "utf8")) ?? { uid: AGENT_UID, gid: AGENT_GID };
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  chownSync(CODEX_HOME, uid, gid);
  writeFileSync(CODEX_AUTH_FILE, authJson, { mode: 0o600 });
  chownSync(CODEX_AUTH_FILE, uid, gid);
  const webSearch = nativeTools?.includes("web_search") ?? false;
  if (mcpUrl || webSearch) {
    writeFileSync(CODEX_CONFIG_FILE, codexConfigToml({ mcpUrl, webSearch }), { mode: 0o600 });
    chownSync(CODEX_CONFIG_FILE, uid, gid);
  }
  mkdirSync(CODEX_WORK_DIR, { recursive: true, mode: 0o700 });
  chownSync(CODEX_WORK_DIR, uid, gid);
}

/** The login file after the run. Codex rewrites it when it refreshes the login, and the backend keeps the new one. */
export function readCodexAuth(): string | undefined {
  try {
    const text = readFileSync(CODEX_AUTH_FILE, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 300;
  if (!/^\d+$/.test(raw)) throw new Error("DRAFT_TIMEOUT_SECONDS must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600) {
    throw new Error("DRAFT_TIMEOUT_SECONDS must be between 1 and 3600");
  }
  return value;
}

export function shouldRetryCallback(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// Every line of stream-json output is its own JSON message (system init,
// assistant turns, tool calls/results, and the final "result" envelope).
// Kept alongside parseCompletedClaudeEnvelope rather than replacing it --
// this returns the whole transcript, that one still finds just the
// terminal envelope for control flow.
export function parseStreamJsonTranscript(raw: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON progress/partial lines are expected in a streamed buffer.
    }
  }
  return messages;
}

export function readOutputSchema(path: string, inputRoot = "/run/input"): string {
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolve(inputRoot)}/`) || !existsSync(resolvedPath)) {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must name a file beneath /run/input");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must contain valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must contain a JSON object");
  }
  return JSON.stringify(parsed);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secureInputTree(path: string): { fileCount: number; totalBytes: number } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("input tree must not contain symlinks");
  if (stat.uid !== 0 || stat.gid !== 0) chownSync(path, 0, 0);
  chmodSync(path, stat.isDirectory() ? 0o555 : 0o444);
  let fileCount = stat.isDirectory() ? 0 : 1;
  let totalBytes = stat.isDirectory() ? 0 : stat.size;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      const child = secureInputTree(join(path, entry));
      fileCount += child.fileCount;
      totalBytes += child.totalBytes;
    }
  }
  return { fileCount, totalBytes };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, "wx", 0o640);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

async function stopChild(child: ReturnType<typeof import("node:child_process")["spawn"]>): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export async function callback(
  url: string,
  token: string,
  runId: string,
  bundleHash: string,
  body: unknown,
  transcript: unknown[] | undefined,
  delays: number[] = [0, 1_000, 3_000, 7_000],
): Promise<void> {
  let lastError = "callback failed";
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    try {
      runnerLog("callback_attempt", { run_id: runId, attempt: attempt + 1 });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `draft:${runId}:${bundleHash}`,
          "x-draft-run-id": runId,
          "x-draft-bundle-hash": bundleHash,
        },
        body: JSON.stringify({
          run_id: runId,
          bundle_hash: bundleHash,
          result: body,
          ...(transcript !== undefined ? { transcript } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      response.body?.cancel().catch(() => undefined);
      runnerLog("callback_status", {
        run_id: runId,
        attempt: attempt + 1,
        status: response.status,
        retry: !response.ok && shouldRetryCallback(response.status) && attempt + 1 < delays.length,
      });
      if (response.ok) {
        runnerLog("callback_delivered", { run_id: runId, attempt: attempt + 1 });
        return;
      }
      lastError = `callback returned HTTP ${response.status}`;
      if (shouldRetryCallback(response.status) && attempt + 1 < delays.length) {
        runnerLog("callback_retry", {
          run_id: runId,
          attempt: attempt + 1,
          retry: true,
          category: "http_status",
        });
      }
      if (!shouldRetryCallback(response.status)) break;
    } catch {
      runnerLog("callback_retry", {
        run_id: runId,
        attempt: attempt + 1,
        retry: attempt + 1 < delays.length,
        category: "transport",
      });
      lastError = "callback transport failed";
    }
  }
  throw new CallbackDeliveryError(lastError);
}

export interface RunnerContext {
  runId: string;
  bundleHash: string;
  callbackUrl: string;
  callbackToken: string;
}

// Never throws and skips reportAndExit: that path does root-only chown and
// writes /run/output, which may be exactly what failed.
export async function reportRunnerFailure(
  ctx: RunnerContext,
  error: unknown,
  delays?: number[],
): Promise<void> {
  const reason = sanitizeReason(error, ctx.callbackToken);
  runnerLog("runner_error", { run_id: ctx.runId, reason });
  try {
    await callback(
      ctx.callbackUrl,
      ctx.callbackToken,
      ctx.runId,
      ctx.bundleHash,
      { error: "runner_error", diagnostics: { reason } },
      undefined,
      delays,
    );
  } catch (callbackError) {
    runnerLog("runner_error_callback_failed", {
      run_id: ctx.runId,
      reason: sanitizeReason(callbackError, ctx.callbackToken),
    });
  }
}

async function reportAndExit(input: {
  finalResult: unknown;
  success: boolean;
  failureCode: RunnerFailureCode | "none";
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  bundleHash: string;
  transcript?: unknown[];
}): Promise<void> {
  try {
    mkdirSync("/run/output", { recursive: true });
    chownSync("/run/output", 0, 0);
    chmodSync("/run/output", 0o750);
    atomicWriteJson(OUTPUT_PATH, input.finalResult);
  } catch (writeError) {
    // The callback is the source of truth; a local output file must not block it.
    runnerLog("output_write_failed", {
      run_id: input.runId,
      reason: sanitizeReason(writeError, input.callbackToken),
    });
  }
  await callback(
    input.callbackUrl,
    input.callbackToken,
    input.runId,
    input.bundleHash,
    input.finalResult,
    input.transcript,
  );

  runnerLog("final", {
    run_id: input.runId,
    status: input.success ? "completed" : "failed",
    failure_code: input.failureCode,
  });
  if (!input.success) process.exitCode = 1;
}

export function assertWithinInputRoot(target: string, inputRoot: string, path: string): void {
  const resolvedRoot = resolve(inputRoot);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`bundle file path escapes input root: ${path}`);
  }
}

export function recomputeBundleHash(
  files: Record<string, string>,
  reservedPaths: ReadonlySet<string>,
): string {
  const entries = Object.entries(files)
    .filter(([path]) => !reservedPaths.has(path))
    .map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      return [path, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function fetchAndWriteBundle(
  bundleUrl: string,
  bundleHash: string,
  inputRoot: string,
  bundleRoot: string,
  reservedPaths: ReadonlySet<string>,
): Promise<void> {
  const response = await fetch(bundleUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`bundle fetch returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isObject(payload) || !isObject(payload.files)) {
    throw new Error("bundle payload must be a JSON object with a files map");
  }
  const downloadedFiles = payload.files as Record<string, string>;
  for (const [path, content] of Object.entries(downloadedFiles)) {
    if (typeof content !== "string") throw new Error(`bundle file content must be a string: ${path}`);
  }

  const recomputedHash = recomputeBundleHash(downloadedFiles, reservedPaths);
  if (recomputedHash !== bundleHash) {
    throw new Error("bundle content does not match DRAFT_BUNDLE_HASH");
  }

  // Bundle keys (e.g. "input/prompt.md") already carry the "input/" segment,
  // so they're relative to bundleRoot (/run), not inputRoot (/run/input) —
  // joining against inputRoot would double it to /run/input/input/....
  for (const [path, content] of Object.entries(downloadedFiles)) {
    const target = join(bundleRoot, path);
    assertWithinInputRoot(target, inputRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

// ---- The run manifest ------------------------------------------------------------------------------
// What this run must do: which harness, which tools, what kind of output. The backend builds it from the
// run's spec (backend/src/sandbox/run-manifest.ts) and it holds no secret. The runner is built apart from the
// backend, so it keeps its own parser, and a test holds the two together.

export interface RunnerManifest {
  version: 1;
  harness: "claude" | "codex";
  model: string | null;
  prompt: { kind: "file"; path: string } | { kind: "items"; manifestPath: string };
  tools: { native: string[]; draftMcpUrl: string | null };
  output: { kind: "stream" } | { kind: "structured"; schemaPath: string };
  timeoutSeconds: number;
}

function onlyKeys(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`run manifest: ${label} must be an object`);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new Error(`run manifest: unknown key in ${label}: ${extra}`);
  return value;
}

function pathUnder(path: unknown, label: string, inputRoot: string): string {
  if (typeof path !== "string" || !resolve(path).startsWith(`${resolve(inputRoot)}/`)) {
    throw new Error(`run manifest: ${label} must be a file under ${inputRoot}`);
  }
  return path;
}

/** Checks a manifest strictly. Anything the runner does not know is refused, because these values reach a command line. */
export function validateRunnerManifest(value: unknown, callbackUrl: string, inputRoot = "/run/input"): RunnerManifest {
  const top = onlyKeys(value, ["version", "harness", "model", "prompt", "tools", "output", "timeoutSeconds"], "manifest");
  if (top.version !== 1) throw new Error("run manifest: version must be 1");
  if (top.harness !== "claude" && top.harness !== "codex") throw new Error("run manifest: harness must be claude or codex");
  const harness = top.harness;
  if (top.model !== null && (typeof top.model !== "string" || !MODEL_PATTERN.test(top.model))) throw new Error("run manifest: model is invalid");
  if (typeof top.timeoutSeconds !== "number" || !Number.isSafeInteger(top.timeoutSeconds) || top.timeoutSeconds < 1 || top.timeoutSeconds > 3600) {
    throw new Error("run manifest: timeoutSeconds must be between 1 and 3600");
  }

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
  const allowedNative = RUNNER_NATIVE_TOOLS[harness] as ReadonlyArray<string>;
  if (!Array.isArray(toolsValue.native) || !toolsValue.native.every((tool) => typeof tool === "string" && allowedNative.includes(tool))) {
    throw new Error("run manifest: tools.native has a tool this harness may not use");
  }
  if (toolsValue.draftMcpUrl !== null && typeof toolsValue.draftMcpUrl !== "string") throw new Error("run manifest: tools.draftMcpUrl must be a string or null");
  const tools = {
    native: [...new Set(toolsValue.native as string[])],
    draftMcpUrl: toolsValue.draftMcpUrl === null ? null : routineMcpUrl(toolsValue.draftMcpUrl as string, callbackUrl),
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

  if (harness === "codex" && (output.kind === "structured" || prompt.kind === "items")) {
    throw new Error("run manifest: codex runs stream a single prompt");
  }
  return { version: 1, harness, model: top.model as string | null, prompt, tools, output, timeoutSeconds: top.timeoutSeconds };
}

export function parseRunnerManifest(raw: string, callbackUrl: string, inputRoot = "/run/input"): RunnerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("run manifest: DRAFT_RUN_MANIFEST must contain valid JSON");
  }
  return validateRunnerManifest(parsed, callbackUrl, inputRoot);
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
    callbackUrl,
    inputRoot,
  );
}

export function loadRunnerManifest(env: NodeJS.ProcessEnv, callbackUrl: string): RunnerManifest {
  return env.DRAFT_RUN_MANIFEST ? parseRunnerManifest(env.DRAFT_RUN_MANIFEST, callbackUrl) : manifestFromLegacyEnv(env, callbackUrl);
}

// ---- One command builder per harness ---------------------------------------------------------------

/** Claude Code's command. Reading is allowed on its own; any other built-in tool has to be named, or dontAsk refuses it. */
export function claudeArgs(manifest: RunnerManifest, prompt: string, schemaText: string | null): string[] {
  if (manifest.harness !== "claude") throw new Error("claudeArgs needs a Claude manifest");
  if (manifest.output.kind === "structured" && schemaText === null) throw new Error("structured output needs a schema");
  const { model } = manifest;
  const { native, draftMcpUrl } = manifest.tools;
  // Claude Code turns dots in tool names into underscores, so Draft's tools are allowed by server name.
  const allowed = [...(draftMcpUrl ? ["mcp__draft"] : []), ...native.filter((tool) => !CLAUDE_READ_ONLY_TOOLS.includes(tool))];
  return [
    "-p",
    prompt,
    ...(model ? ["--model", model] : []),
    "--tools",
    native.join(","),
    "--permission-mode",
    "dontAsk",
    ...(draftMcpUrl ? ["--mcp-config", claudeMcpConfigJson(draftMcpUrl), "--strict-mcp-config"] : []),
    ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(manifest.output.kind === "structured" ? ["--json-schema", schemaText!] : []),
  ];
}

/** Codex reads the prompt from stdin. It may write inside its work folder only, and keeps no session on disk. */
export function codexArgs(manifest: RunnerManifest): string[] {
  if (manifest.harness !== "codex") throw new Error("codexArgs needs a Codex manifest");
  return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", ...(manifest.model ? ["-m", manifest.model] : []), "-"];
}

export interface HarnessCommand {
  argv: string[];
  stdin: string | null;
  cwd: string;
  env: Record<string, string>;
}

export function harnessCommand(manifest: RunnerManifest, prompt: string, schemaText: string | null, env: NodeJS.ProcessEnv): HarnessCommand {
  if (manifest.harness === "codex") {
    return { argv: ["codex", ...codexArgs(manifest)], stdin: prompt, cwd: CODEX_WORK_DIR, env: sanitizedCodexEnv(env) };
  }
  return { argv: ["claude", ...claudeArgs(manifest, prompt, schemaText)], stdin: null, cwd: "/run", env: sanitizedClaudeEnv(env) };
}

/** Anything the harness needs on disk before it starts. For Codex that is its home: the login and its config. */
export function prepareHarness(manifest: RunnerManifest, env: NodeJS.ProcessEnv): void {
  if (manifest.harness !== "codex") return;
  if (!env.CODEX_AUTH_JSON) throw new Error("CODEX_AUTH_JSON is required");
  prepareCodexHome(env.CODEX_AUTH_JSON, manifest.tools.draftMcpUrl, manifest.tools.native);
}

// ---- Running a harness -----------------------------------------------------------------------------

interface HarnessRun {
  manifest: RunnerManifest;
  prompt: string;
  schemaText: string | null;
  runId: string;
  timeoutMs: number;
  onStdout: (chunk: Buffer, stop: () => void) => void;
  onStderr: (text: string) => void;
  /** Runs every `everyMs` while the harness runs. */
  tick?: { everyMs: number; run: () => void };
}

/** Starts the harness as the agent user, hands its output to the caller, and stops it on the timeout. */
async function runHarness(input: HarnessRun): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; timedOut: boolean }> {
  const { spawn } = await import("node:child_process");
  const command = harnessCommand(input.manifest, input.prompt, input.schemaText, process.env);
  const envArgs = Object.entries(command.env).map(([key, value]) => `${key}=${value}`);
  const [program, ...args] = command.argv;
  const child = spawn("gosu", ["agent", "env", "-i", ...envArgs, program!, ...args], {
    cwd: command.cwd,
    detached: true,
    stdio: [command.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (command.stdin !== null) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(command.stdin);
  }
  const codex = input.manifest.harness === "codex";
  runnerLog(codex ? "codex_started" : "claude_started", {
    run_id: input.runId,
    ...(codex ? { sandbox: "workspace-write" } : { tools: input.manifest.tools.native.join(","), permission_mode: "dontAsk" }),
    draft_tools: input.manifest.tools.draftMcpUrl !== null,
    output: input.manifest.output.kind,
    timeout_ms: input.timeoutMs,
  });

  child.stdout?.on("data", (chunk: Buffer) => input.onStdout(chunk, () => void stopChild(child)));
  child.stderr?.on("data", (chunk: Buffer) => input.onStderr(chunk.toString("utf8")));
  const ticker = input.tick ? setInterval(input.tick.run, input.tick.everyMs) : null;

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopChild(child);
  }, input.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timeout);
  if (ticker) clearInterval(ticker);
  await stopChild(child);
  return { exit, timedOut };
}

export interface StructuredRunResult {
  success: boolean;
  finalResult: unknown;
  failureCode: RunnerFailureCode | "none";
  diagnostics: FinalDiagnosticInput;
  transcript: unknown[];
}

// scratchStdoutPath must be unique per invocation within a run -- it's
// opened with the "wx" flag (fails if it already exists).
/** One harness run that ends in one structured result, which the caller sends back in a single callback. */
export async function runStructured(
  manifest: RunnerManifest,
  prompt: string,
  schemaText: string,
  timeoutMs: number,
  runId: string,
  scratchStdoutPath: string = SCRATCH_STDOUT_PATH,
): Promise<StructuredRunResult> {
  const startedAt = Date.now();
  const stdoutFile = createWriteStream(scratchStdoutPath, { flags: "wx", mode: 0o600 });
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let completed: ClaudeEnvelope | null = null;
  let failureCategory: ClaudeFailureCategory = "none";

  const { exit: childExit, timedOut } = await runHarness({
    manifest,
    prompt,
    schemaText,
    runId,
    timeoutMs,
    onStdout: (chunk, stop) => {
      stdoutBytes += chunk.length;
      stdoutFile.write(chunk);
      if (Buffer.byteLength(stdout) + chunk.length <= MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
      else overflow = true;
      completed = parseCompletedClaudeEnvelope(stdout);
      if (completed) stop();
    },
    onStderr: (text) => {
      stderrBytes += Buffer.byteLength(text);
      stderr += text;
      failureCategory = classifyClaudeFailureChunk(text, failureCategory);
    },
  });
  stdoutFile.end();

  const envelope = completed || parseCompletedClaudeEnvelope(stdout);
  const payload = extractStructuredOutput(envelope);
  failureCategory = classifyClaudeEnvelopeFailure(envelope, failureCategory);

  const diagnosticsInput: FinalDiagnosticInput = {
    timedOut,
    overflow,
    envelopeFound: envelope !== null,
    envelopeIsError: envelope?.is_error === true,
    payloadValid: payload !== null,
    exitCode: childExit.code,
    signal: childExit.signal,
    failureCategory,
  };
  const failure = buildFailureDiagnostics(diagnosticsInput);
  const success = failure === null;
  runnerLog("claude_finished", {
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    exit_code: childExit.code,
    signal: childExit.signal,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    overflow,
    timed_out: timedOut,
    envelope_found: diagnosticsInput.envelopeFound,
    envelope_is_error: diagnosticsInput.envelopeIsError,
    payload_valid: diagnosticsInput.payloadValid,
    failure_category: failureCategory,
    failure_code: failure?.failureCode ?? "none",
  });
  const finalResult = success
    ? payload
    : {
        error: failure!.failureCode,
        diagnostics: failure!,
        stderr,
      };

  return {
    success,
    finalResult,
    failureCode: failure?.failureCode ?? "none",
    diagnostics: diagnosticsInput,
    transcript: parseStreamJsonTranscript(stdout),
  };
}

// Routine runs stream every stream-json line to the backend as it appears, so
// the session view fills in while the run is going.
const ROUTINE_FLUSH_INTERVAL_MS = 1_500;
const ROUTINE_FLUSH_BYTES = 512 * 1024;
const ROUTINE_MAX_LINE_BYTES = 4 * 1024 * 1024;
const ROUTINE_FILE = "root.jsonl";
const MODEL_PATTERN = /^[A-Za-z0-9._:\-\[\]]{1,100}$/;

export type RoutineLine =
  | { file: string; offset: number; raw: string }
  | { file: string; offset: number; oversizeBytes: number };

/** The end of a `codex exec --json` run: a finished turn is a result, a failed turn is an error result. */
export function parseCodexResultLine(raw: string): { is_error: boolean; subtype: string } | null {
  if (!raw.includes('"type":"turn.completed"') && !raw.includes('"type":"turn.failed"')) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (parsed.type === "turn.completed") return { is_error: false, subtype: "turn.completed" };
    if (parsed.type === "turn.failed") return { is_error: true, subtype: "turn.failed" };
  } catch { /* a partial line is not the result */ }
  return null;
}

// Cuts decoded stdout into whole lines. Offsets count bytes, so a line keeps the
// same id (file + offset) however the chunks fall.
export class StreamLineReader {
  private pending = "";
  private offset = 0;

  push(text: string): RoutineLine[] {
    this.pending += text;
    const lines: RoutineLine[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      lines.push(...this.take(this.pending.slice(0, newline)));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    return lines;
  }

  finish(): RoutineLine[] {
    const rest = this.pending;
    this.pending = "";
    return rest ? this.take(rest) : [];
  }

  private take(raw: string): RoutineLine[] {
    const offset = this.offset;
    const bytes = Buffer.byteLength(raw);
    this.offset += bytes + 1;
    if (!raw.trim()) return [];
    if (bytes > ROUTINE_MAX_LINE_BYTES) return [{ file: ROUTINE_FILE, offset, oversizeBytes: bytes }];
    return [{ file: ROUTINE_FILE, offset, raw }];
  }
}

export interface RoutineEnd {
  kind: "end";
  ok: boolean;
  error?: RunnerFailureCode;
  diagnostics?: Record<string, unknown>;
  /** A Codex run sends back its login file, which Codex may have refreshed. */
  auth_json?: string;
}

export type RoutinePost = (result: unknown) => Promise<void>;

export function routineFailureCode(input: { timedOut: boolean; resultIsError: boolean; exitCode: number | null; signal: NodeJS.Signals | null; harness?: "claude" | "codex" }): RunnerFailureCode {
  const codex = input.harness === "codex";
  if (input.timedOut) return "timeout";
  if (input.resultIsError) return codex ? "codex_error" : "claude_error";
  if (input.exitCode !== 0 || input.signal !== null) return codex ? "codex_exit" : "claude_exit";
  return "incomplete_result";
}

/** One harness run whose every output line is sent to the backend as it appears, so the session view fills in live. */
export async function runStream(
  manifest: RunnerManifest,
  prompt: string,
  timeoutMs: number,
  runId: string,
  post: RoutinePost,
): Promise<RoutineEnd> {
  const { StringDecoder } = await import("node:string_decoder");
  const codex = manifest.harness === "codex";
  const reader = new StreamLineReader();
  const decoder = new StringDecoder("utf8");
  let queue: RoutineLine[] = [];
  let queuedBytes = 0;
  let sending: Promise<void> = Promise.resolve();
  let resultLine: { is_error?: boolean; subtype?: string } | null = null;
  let failureCategory: ClaudeFailureCategory = "none";
  let stderr = "";

  // Sends are chained so batches reach the backend in order. A batch that cannot
  // be delivered is dropped: events are keyed by line id, and the run goes on.
  const flush = (): void => {
    if (queue.length === 0) return;
    const lines = queue;
    queue = [];
    queuedBytes = 0;
    sending = sending.then(() =>
      post({ kind: "lines", lines }).catch((error) =>
        runnerLog("routine_lines_dropped", { run_id: runId, count: lines.length, reason: sanitizeReason(error) }),
      ),
    );
  };
  const enqueue = (lines: RoutineLine[]): void => {
    for (const line of lines) {
      if ("raw" in line) {
        queuedBytes += Buffer.byteLength(line.raw);
        if (codex) {
          resultLine = parseCodexResultLine(line.raw) ?? resultLine;
        } else if (line.raw.includes('"type":"result"')) {
          try {
            const parsed: unknown = JSON.parse(line.raw);
            if (isObject(parsed) && parsed.type === "result") resultLine = parsed as { is_error?: boolean; subtype?: string };
          } catch { /* a partial line is not the result */ }
        }
      }
      queue.push(line);
    }
    if (queuedBytes >= ROUTINE_FLUSH_BYTES) flush();
  };

  const { exit: childExit, timedOut } = await runHarness({
    manifest,
    prompt,
    schemaText: null,
    runId,
    timeoutMs,
    onStdout: (chunk) => enqueue(reader.push(decoder.write(chunk))),
    onStderr: (text) => {
      if (stderr.length < 2_000) stderr += text;
      failureCategory = classifyClaudeFailureChunk(text, failureCategory);
    },
    tick: { everyMs: ROUTINE_FLUSH_INTERVAL_MS, run: flush },
  });
  enqueue(reader.push(decoder.end()));
  enqueue(reader.finish());
  flush();
  await sending;

  const finished = resultLine as { is_error?: boolean; subtype?: string } | null;
  const ok = !timedOut && finished !== null && finished.is_error !== true && childExit.code === 0;
  const error = ok ? undefined : routineFailureCode({ timedOut, resultIsError: finished?.is_error === true, exitCode: childExit.code, signal: childExit.signal, harness: manifest.harness });
  const authJson = codex ? readCodexAuth() : undefined;
  runnerLog(codex ? "codex_finished" : "claude_finished", {
    run_id: runId,
    exit_code: childExit.code,
    signal: childExit.signal,
    timed_out: timedOut,
    result_found: finished !== null,
    failure_category: failureCategory,
    failure_code: error ?? "none",
  });
  const refreshed = authJson ? { auth_json: authJson } : {};
  return ok
    ? { kind: "end", ok: true, ...refreshed }
    : {
        kind: "end",
        ok: false,
        error,
        diagnostics: {
          failure_category: failureCategory,
          exit_code: childExit.code,
          signal: childExit.signal,
          result_subtype: finished?.subtype ?? null,
          stderr: sanitizeReason(stderr),
        },
        ...refreshed,
      };
}

const MAX_BATCH_ENTRIES = 25;
const BATCH_WALL_CLOCK_BUDGET_MS = 18 * 60 * 1_000;

export interface BatchManifestEntry {
  id: string;
  promptPath: string;
}

export interface BatchResultItem {
  sessionId: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}

export function parseBatchManifest(raw: string): BatchManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DRAFT_MANIFEST_PATH must contain valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("batch manifest must be a JSON array");
  const entries: BatchManifestEntry[] = [];
  for (const raw_entry of parsed) {
    if (
      !isObject(raw_entry) ||
      typeof raw_entry.id !== "string" ||
      !raw_entry.id ||
      typeof raw_entry.promptPath !== "string" ||
      !raw_entry.promptPath
    ) {
      throw new Error("batch manifest entries must have a nonempty id and promptPath");
    }
    entries.push({ id: raw_entry.id, promptPath: raw_entry.promptPath });
  }
  return entries.slice(0, MAX_BATCH_ENTRIES);
}

export interface RunBatchInput {
  manifest: RunnerManifest;
  runId: string;
  bundleHash: string;
  manifestPath: string;
  serializedSchema: string;
  inputRoot: string;
  bundleRoot: string;
  timeoutMs: number;
  callbackUrl: string;
  callbackToken: string;
}

export async function runBatch(
  input: RunBatchInput,
  deps: { runStructured: typeof runStructured; reportAndExit: typeof reportAndExit } = {
    runStructured,
    reportAndExit,
  },
): Promise<void> {
  if (!existsSync(input.manifestPath) || !resolve(input.manifestPath).startsWith(`${input.inputRoot}/`)) {
    throw new Error("DRAFT_MANIFEST_PATH must name a file beneath /run/input");
  }
  const entries = parseBatchManifest(readFileSync(input.manifestPath, "utf8"));

  const items: BatchResultItem[] = [];
  const batchStartedAt = Date.now();
  for (const [index, entry] of entries.entries()) {
    if (Date.now() - batchStartedAt >= BATCH_WALL_CLOCK_BUDGET_MS) {
      runnerLog("batch_budget_exceeded", { run_id: input.runId, remaining: entries.length - index });
      break;
    }

    // One session that throws must not discard the others' results.
    try {
      const promptTarget = join(input.bundleRoot, entry.promptPath);
      assertWithinInputRoot(promptTarget, input.inputRoot, entry.promptPath);
      if (!existsSync(promptTarget)) {
        items.push({ sessionId: entry.id, ok: false, error: { error: "prompt_missing" } });
        continue;
      }
      const prompt = readFileSync(promptTarget, "utf8");

      const scratchStdoutPath = `/run/scratch/claude.stdout.${index}.json`;
      const result = await deps.runStructured(
        input.manifest,
        prompt,
        input.serializedSchema,
        input.timeoutMs,
        input.runId,
        scratchStdoutPath,
      );
      items.push(
        result.success
          ? { sessionId: entry.id, ok: true, payload: result.finalResult }
          : { sessionId: entry.id, ok: false, error: result.finalResult },
      );
    } catch (sessionError) {
      const reason = sanitizeReason(sessionError, input.callbackToken);
      runnerLog("batch_session_error", { run_id: input.runId, session_id: entry.id, reason });
      items.push({
        sessionId: entry.id,
        ok: false,
        error: { error: "runner_error", diagnostics: { reason } },
      });
    }
  }

  await deps.reportAndExit({
    finalResult: { items },
    success: true,
    failureCode: "none",
    callbackUrl: input.callbackUrl,
    callbackToken: input.callbackToken,
    runId: input.runId,
    bundleHash: input.bundleHash,
  });
}

// Only the callback identifiers are parsed outside the try: without them no
// failure can be reported. Everything after reports through reportRunnerFailure.
export async function main(): Promise<void> {
  const runId = required("DRAFT_RUN_ID");
  const bundleHash = required("DRAFT_BUNDLE_HASH");
  if (!/^[0-9a-f]{64}$/.test(bundleHash)) {
    throw new Error("DRAFT_BUNDLE_HASH must be lowercase SHA-256");
  }
  const ctx: RunnerContext = {
    runId,
    bundleHash,
    callbackUrl: required("DRAFT_CALLBACK_URL"),
    callbackToken: required("DRAFT_CALLBACK_TOKEN"),
  };
  try {
    await runMainBody(ctx);
  } catch (error) {
    // A failed callback was already logged by callback(); don't post again.
    if (!(error instanceof CallbackDeliveryError)) await reportRunnerFailure(ctx, error);
    runnerLog("final", { run_id: runId, status: "failed", failure_code: "runner_error" });
    process.exitCode = 1;
  }
}

async function runMainBody(ctx: RunnerContext): Promise<void> {
  const { runId, bundleHash, callbackUrl, callbackToken } = ctx;
  const bundleUrl = required("DRAFT_BUNDLE_URL");
  new URL(bundleUrl);
  new URL(callbackUrl);
  const manifest = loadRunnerManifest(process.env, callbackUrl);
  const timeoutMs = manifest.timeoutSeconds * 1_000;
  const inputRoot = "/run/input";
  // Bundle file keys (e.g. "input/prompt.md", "input/sources/x.md") already
  // carry the "input/" segment, so they're relative to /run, one level above
  // inputRoot — not to inputRoot itself.
  const bundleRoot = dirname(inputRoot);
  // The prompt and the schema are added to the upload after its hash is computed, so they are not part of it.
  const reservedPaths = new Set(["input/prompt.md", "input/output-schema.json"]);
  if (manifest.prompt.kind === "file" && manifest.prompt.path.startsWith(`${bundleRoot}/`)) reservedPaths.add(manifest.prompt.path.slice(bundleRoot.length + 1));
  if (manifest.output.kind === "structured" && manifest.output.schemaPath.startsWith(`${bundleRoot}/`)) reservedPaths.add(manifest.output.schemaPath.slice(bundleRoot.length + 1));

  mkdirSync("/run/output", { recursive: true });
  mkdirSync("/run/scratch", { recursive: true });
  mkdirSync(inputRoot, { recursive: true });
  try {
    await fetchAndWriteBundle(bundleUrl, bundleHash, inputRoot, bundleRoot, reservedPaths);
  } catch (fetchError) {
    const reason = sanitizeReason(fetchError, callbackToken);
    runnerLog("bundle_fetch_failed", { run_id: runId, error: reason });
    await reportAndExit({
      finalResult: { error: "bundle_fetch_failed", diagnostics: { reason } },
      success: false,
      failureCode: "bundle_fetch_failed",
      callbackUrl,
      callbackToken,
      runId,
      bundleHash,
    });
    return;
  }
  const inputStats = secureInputTree(inputRoot);

  // Items carry a prompt file each, read by runBatch. Otherwise there is one prompt.
  let prompt = "";
  if (manifest.prompt.kind === "file") {
    const promptPath = manifest.prompt.path;
    if (!existsSync(promptPath) || !resolve(promptPath).startsWith(`${inputRoot}/`)) {
      throw new Error("the prompt must be a file beneath /run/input");
    }
    prompt = readFileSync(promptPath, "utf8");
    if (!prompt.trim()) throw new Error("prompt is empty");
  }
  runnerLog("input_ready", {
    run_id: runId,
    file_count: inputStats.fileCount,
    total_bytes: inputStats.totalBytes,
    prompt_bytes: Buffer.byteLength(prompt),
  });

  chownSync("/run/output", AGENT_UID, AGENT_GID);
  chmodSync("/run/output", 0o750);
  chownSync("/run/scratch", AGENT_UID, AGENT_GID);
  chmodSync("/run/scratch", 0o700);

  if (manifest.tools.draftMcpUrl) required("DRAFT_RUN_TOKEN");

  if (manifest.output.kind === "stream") {
    prepareHarness(manifest, process.env);
    delete process.env.CODEX_AUTH_JSON;
    const end = await runStream(manifest, prompt, timeoutMs, runId, (result) =>
      callback(callbackUrl, callbackToken, runId, bundleHash, result, undefined),
    );
    await callback(callbackUrl, callbackToken, runId, bundleHash, end, undefined);
    runnerLog("final", { run_id: runId, status: end.ok ? "completed" : "failed", failure_code: end.error ?? "none" });
    if (!end.ok) process.exitCode = 1;
    return;
  }

  const serializedSchema = readOutputSchema(manifest.output.schemaPath, inputRoot);

  if (manifest.prompt.kind === "items") {
    await runBatch({
      manifest,
      runId,
      bundleHash,
      manifestPath: manifest.prompt.manifestPath,
      serializedSchema,
      inputRoot,
      bundleRoot,
      timeoutMs,
      callbackUrl,
      callbackToken,
    });
    return;
  }

  const result = await runStructured(manifest, prompt, serializedSchema, timeoutMs, runId);

  await reportAndExit({
    finalResult: result.finalResult,
    success: result.success,
    failureCode: result.failureCode,
    callbackUrl,
    callbackToken,
    runId,
    bundleHash,
    transcript: result.transcript,
  });
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
if (realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  // Reached only when a callback identifier is missing, so no callback is possible.
  main().catch((error) => {
    runnerLog("runner_error", { reason: sanitizeReason(error) });
    runnerLog("final", { status: "failed", failure_code: "runner_error" });
    process.exitCode = 1;
  });
}
