import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerManifest } from "draft-core/run-manifest";
import { assertWithinInputRoot } from "./bundle";
import { reportAndExit } from "./callback";
import { runnerLog, sanitizeReason } from "./log";
import { runStructured } from "./structured";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
