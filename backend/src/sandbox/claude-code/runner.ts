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
  | "incomplete_result"
  | "bundle_fetch_failed";

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

async function reportAndExit(input: {
  finalResult: unknown;
  success: boolean;
  failureCode: RunnerFailureCode | "none";
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  bundleHash: string;
}): Promise<void> {
  mkdirSync("/run/output", { recursive: true });
  chownSync("/run/output", 0, 0);
  chmodSync("/run/output", 0o750);
  atomicWriteJson(OUTPUT_PATH, input.finalResult);
  await callback(input.callbackUrl, input.callbackToken, input.runId, input.bundleHash, input.finalResult);

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

export interface RunClaudeOnceResult {
  success: boolean;
  finalResult: unknown;
  failureCode: RunnerFailureCode | "none";
  diagnostics: FinalDiagnosticInput;
}

// scratchStdoutPath must be unique per invocation within a run -- it's
// opened with the "wx" flag (fails if it already exists).
export async function runClaudeOnce(
  prompt: string,
  serializedSchema: string,
  timeoutMs: number,
  runId: string,
  scratchStdoutPath: string = SCRATCH_STDOUT_PATH,
): Promise<RunClaudeOnceResult> {
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

  const stdoutFile = createWriteStream(scratchStdoutPath, { flags: "wx", mode: 0o600 });
  let stdout = "";
  let stderr = "";
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
    const text = chunk.toString("utf8");
    stderr += text;
    failureCategory = classifyClaudeFailureChunk(text, failureCategory);
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
    : {
        error: failure!.failureCode,
        diagnostics: failure!,
        stderr,
        // The envelope's own error text (its `result` field when
        // is_error) is usually more diagnostic than raw stderr.
        envelope_result:
          envelope?.is_error === true && typeof envelope.result === "string"
            ? envelope.result
            : undefined,
      };

  return {
    success,
    finalResult,
    failureCode: failure?.failureCode ?? "none",
    diagnostics: diagnosticsInput,
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

async function runBatch(input: {
  runId: string;
  bundleHash: string;
  manifestPath: string;
  serializedSchema: string;
  inputRoot: string;
  bundleRoot: string;
  timeoutMs: number;
  callbackUrl: string;
  callbackToken: string;
}): Promise<void> {
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

    const promptTarget = join(input.bundleRoot, entry.promptPath);
    assertWithinInputRoot(promptTarget, input.inputRoot, entry.promptPath);
    if (!existsSync(promptTarget)) {
      items.push({ sessionId: entry.id, ok: false, error: { error: "prompt_missing" } });
      continue;
    }
    const prompt = readFileSync(promptTarget, "utf8");

    const scratchStdoutPath = `/run/scratch/claude.stdout.${index}.json`;
    const result = await runClaudeOnce(
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
  }

  await reportAndExit({
    finalResult: { items },
    success: true,
    failureCode: "none",
    callbackUrl: input.callbackUrl,
    callbackToken: input.callbackToken,
    runId: input.runId,
    bundleHash: input.bundleHash,
  });
}

export async function main(): Promise<void> {
  const runId = required("DRAFT_RUN_ID");
  const bundleHash = required("DRAFT_BUNDLE_HASH");
  if (!/^[0-9a-f]{64}$/.test(bundleHash)) {
    throw new Error("DRAFT_BUNDLE_HASH must be lowercase SHA-256");
  }
  const callbackUrl = required("DRAFT_CALLBACK_URL");
  const callbackToken = required("DRAFT_CALLBACK_TOKEN");
  const bundleUrl = required("DRAFT_BUNDLE_URL");
  new URL(bundleUrl);
  const promptPath = process.env.DRAFT_PROMPT_PATH || DEFAULT_PROMPT_PATH;
  const outputSchemaPath = process.env.DRAFT_OUTPUT_SCHEMA_PATH || DEFAULT_OUTPUT_SCHEMA_PATH;
  const timeoutMs = parseTimeoutSeconds(process.env.DRAFT_TIMEOUT_SECONDS) * 1_000;
  const runMode = process.env.DRAFT_RUN_MODE === "batch" ? "batch" : "single";
  const inputRoot = "/run/input";
  // Bundle file keys (e.g. "input/prompt.md", "input/sources/x.md") already
  // carry the "input/" segment, so they're relative to /run, one level above
  // inputRoot — not to inputRoot itself.
  const bundleRoot = dirname(inputRoot);
  const reservedPaths = new Set([
    promptPath.startsWith(`${bundleRoot}/`) ? promptPath.slice(bundleRoot.length + 1) : "input/prompt.md",
    outputSchemaPath.startsWith(`${bundleRoot}/`)
      ? outputSchemaPath.slice(bundleRoot.length + 1)
      : "input/output-schema.json",
  ]);

  new URL(callbackUrl);
  mkdirSync("/run/output", { recursive: true });
  mkdirSync("/run/scratch", { recursive: true });
  mkdirSync(inputRoot, { recursive: true });
  try {
    await fetchAndWriteBundle(bundleUrl, bundleHash, inputRoot, bundleRoot, reservedPaths);
  } catch (fetchError) {
    runnerLog("bundle_fetch_failed", {
      run_id: runId,
      error: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
    await reportAndExit({
      finalResult: {
        error: "bundle_fetch_failed",
        diagnostics: {
          reason: fetchError instanceof Error ? fetchError.message : String(fetchError),
        },
      },
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
  const serializedSchema = readOutputSchema(outputSchemaPath, inputRoot);

  // Batch mode carries a per-session prompt file per manifest entry instead
  // of one shared prompt at promptPath -- see runBatch.
  let prompt = "";
  if (runMode !== "batch") {
    if (!existsSync(promptPath) || !resolve(promptPath).startsWith(`${inputRoot}/`)) {
      throw new Error("DRAFT_PROMPT_PATH must name a file beneath /run/input");
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

  if (runMode === "batch") {
    const manifestPath = required("DRAFT_MANIFEST_PATH");
    await runBatch({
      runId,
      bundleHash,
      manifestPath,
      serializedSchema,
      inputRoot,
      bundleRoot,
      timeoutMs,
      callbackUrl,
      callbackToken,
    });
    return;
  }

  const result = await runClaudeOnce(prompt, serializedSchema, timeoutMs, runId);

  await reportAndExit({
    finalResult: result.finalResult,
    success: result.success,
    failureCode: result.failureCode,
    callbackUrl,
    callbackToken,
    runId,
    bundleHash,
  });
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
if (realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch(() => {
    runnerLog("final", { status: "failed", failure_code: "runner_error" });
    process.exitCode = 1;
  });
}
