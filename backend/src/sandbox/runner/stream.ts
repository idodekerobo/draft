import { StringDecoder } from "node:string_decoder";
import { classifyFailureChunk } from "draft-core/harnesses/failure";
import type { FailureCategory, RunnerFailureCode } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";
import { runnerFaceFor } from "./faces";
import { runnerLog, sanitizeReason } from "./log";
import { runHarness } from "./process";

// Routine runs stream every stream-json line to the backend as it appears, so
// the session view fills in while the run is going.
const ROUTINE_FLUSH_INTERVAL_MS = 1_500;
const ROUTINE_FLUSH_BYTES = 512 * 1024;
const ROUTINE_MAX_LINE_BYTES = 4 * 1024 * 1024;
const ROUTINE_FILE = "root.jsonl";

export type RoutineLine =
  | { file: string; offset: number; raw: string }
  | { file: string; offset: number; oversizeBytes: number };

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
  const codes = runnerFaceFor(input.harness ?? "claude").failureCodes;
  if (input.timedOut) return "timeout";
  if (input.resultIsError) return codes.error;
  if (input.exitCode !== 0 || input.signal !== null) return codes.exit;
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
  const face = runnerFaceFor(manifest.harness);
  const reader = new StreamLineReader();
  const decoder = new StringDecoder("utf8");
  let queue: RoutineLine[] = [];
  let queuedBytes = 0;
  let sending: Promise<void> = Promise.resolve();
  let resultLine: { is_error?: boolean; subtype?: string } | null = null;
  let failureCategory: FailureCategory = "none";
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
        resultLine = face.resultOfLine(line.raw) ?? resultLine;
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
      failureCategory = classifyFailureChunk(text, failureCategory);
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
  const authJson = face.refreshedLogin();
  runnerLog(face.logNames.finished, {
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
