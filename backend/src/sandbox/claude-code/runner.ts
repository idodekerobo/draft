// Trusted one-shot sandbox lifecycle and callback runner.
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
  | "incomplete_result";

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
  return allowed;
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

export function claudeCommandArgs(prompt: string, serializedSchema: string): string[] {
  return [
    "-p",
    prompt,
    "--tools",
    "Read,Glob",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    serializedSchema,
  ];
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

async function callback(
  url: string,
  token: string,
  runId: string,
  bundleHash: string,
  body: unknown,
): Promise<void> {
  const delays = [0, 1_000, 3_000, 7_000];
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
        body: JSON.stringify({ run_id: runId, bundle_hash: bundleHash, result: body }),
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
  throw new Error(lastError);
}

export async function main(): Promise<void> {
  const runId = required("DRAFT_RUN_ID");
  const bundleHash = required("DRAFT_BUNDLE_HASH");
  if (!/^[0-9a-f]{64}$/.test(bundleHash)) {
    throw new Error("DRAFT_BUNDLE_HASH must be lowercase SHA-256");
  }
  const callbackUrl = required("DRAFT_CALLBACK_URL");
  const callbackToken = required("DRAFT_CALLBACK_TOKEN");
  const promptPath = process.env.DRAFT_PROMPT_PATH || DEFAULT_PROMPT_PATH;
  const outputSchemaPath = process.env.DRAFT_OUTPUT_SCHEMA_PATH || DEFAULT_OUTPUT_SCHEMA_PATH;
  const timeoutMs = parseTimeoutSeconds(process.env.DRAFT_TIMEOUT_SECONDS) * 1_000;
  const inputRoot = "/run/input";

  new URL(callbackUrl);
  mkdirSync("/run/output", { recursive: true });
  mkdirSync("/run/scratch", { recursive: true });
  if (!existsSync(inputRoot)) throw new Error("/run/input is required");
  const inputStats = secureInputTree(inputRoot);
  if (!existsSync(promptPath) || !resolve(promptPath).startsWith(`${inputRoot}/`)) {
    throw new Error("DRAFT_PROMPT_PATH must name a file beneath /run/input");
  }
  const prompt = readFileSync(promptPath, "utf8");
  if (!prompt.trim()) throw new Error("prompt is empty");
  const serializedSchema = readOutputSchema(outputSchemaPath, inputRoot);
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

  const { spawn } = await import("node:child_process");
  const childEnv = sanitizedClaudeEnv(process.env);
  const envArgs = Object.entries(childEnv).map(([key, value]) => `${key}=${value}`);
  const child = spawn(
    "gosu",
    ["agent", "env", "-i", ...envArgs, "claude", ...claudeCommandArgs(prompt, serializedSchema)],
    { cwd: "/run", detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  const startedAt = Date.now();
  runnerLog("claude_started", {
    run_id: runId,
    tools: "Read,Glob",
    permission_mode: "dontAsk",
    timeout_ms: timeoutMs,
  });

  const stdoutFile = createWriteStream(SCRATCH_STDOUT_PATH, { flags: "wx", mode: 0o600 });
  let stdout = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let completed: ClaudeEnvelope | null = null;
  let failureCategory: ClaudeFailureCategory = "none";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutFile.write(chunk);
    if (Buffer.byteLength(stdout) + chunk.length <= MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    else overflow = true;
    completed = parseCompletedClaudeEnvelope(stdout);
    if (completed) void stopChild(child);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    failureCategory = classifyClaudeFailureChunk(chunk.toString("utf8"), failureCategory);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopChild(child);
  }, timeoutMs);
  const childExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timeout);
  stdoutFile.end();
  await stopChild(child);

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
    : { error: failure!.failureCode, diagnostics: failure! };

  chownSync("/run/output", 0, 0);
  chmodSync("/run/output", 0o750);
  atomicWriteJson(OUTPUT_PATH, finalResult);
  await callback(callbackUrl, callbackToken, runId, bundleHash, finalResult);

  runnerLog("final", {
    run_id: runId,
    status: success ? "completed" : "failed",
    failure_code: failure?.failureCode ?? "none",
  });
  if (!success) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
if (realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch(() => {
    runnerLog("final", { status: "failed", failure_code: "runner_error" });
    process.exitCode = 1;
  });
}
