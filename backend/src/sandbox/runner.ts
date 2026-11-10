// Trusted one-shot sandbox lifecycle and callback runner.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBatch } from "./runner/batch";
import { fetchAndWriteBundle, readOutputSchema, secureInputTree } from "./runner/bundle";
import { callback, CallbackDeliveryError, reportAndExit, reportRunnerFailure, type RunnerContext } from "./runner/callback";
import { runnerLog, sanitizeReason } from "./runner/log";
import { loadRunnerManifest } from "./runner/manifest";
import { prepareHarness } from "./runner/process";
import { runStream } from "./runner/stream";
import { runStructured } from "./runner/structured";

const AGENT_UID = 1000;
const AGENT_GID = 1000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
