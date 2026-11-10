import { createWriteStream } from "node:fs";
import { classifyFailureChunk } from "draft-core/harnesses/failure";
import type { FailureCategory, RunnerFailureCode, StructuredResult } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";
import { runnerFaceFor } from "./faces";
import { buildFailureDiagnostics, type FinalDiagnosticInput } from "./failure";
import { runnerLog } from "./log";
import { runHarness } from "./process";

const SCRATCH_STDOUT_PATH = "/run/scratch/claude.stdout.json";
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

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
  const face = runnerFaceFor(manifest.harness);
  const reader = face.structured;
  if (!reader) throw new Error(`${manifest.harness} cannot give a structured result`);
  const startedAt = Date.now();
  const stdoutFile = createWriteStream(scratchStdoutPath, { flags: "wx", mode: 0o600 });
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let completed: StructuredResult | null = null;
  let failureCategory: FailureCategory = "none";

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
      completed = reader.completed(stdout);
      if (completed) stop();
    },
    onStderr: (text) => {
      stderrBytes += Buffer.byteLength(text);
      stderr += text;
      failureCategory = classifyFailureChunk(text, failureCategory);
    },
  });
  stdoutFile.end();

  const envelope = completed || reader.completed(stdout);
  const payload = reader.payload(envelope);
  failureCategory = reader.failureOf(envelope, failureCategory);

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
  runnerLog(face.logNames.finished, {
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
    transcript: reader.transcript(stdout),
  };
}
