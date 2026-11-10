import { chmodSync, chownSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnerFailureCode } from "draft-core/harnesses/types";
import { runnerLog, sanitizeReason } from "./log";

const OUTPUT_PATH = "/run/output/result.json";

export class CallbackDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackDeliveryError";
  }
}

export function shouldRetryCallback(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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

export async function reportAndExit(input: {
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
