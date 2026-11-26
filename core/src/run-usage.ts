/** The token use and cost a harness reports for one run. Saved in `agent_runs.usage_json`. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the harness does not report a cost. */
  costUsd: number | null;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Reads a usage value from a runner. Returns null for anything that is not a full, valid `RunUsage`,
 * so a bad value is dropped and never fails the run that carried it.
 */
export function parseRunUsage(value: unknown): RunUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!TOKEN_FIELDS.every((field) => isCount(record[field]))) return null;
  const cost = record.costUsd;
  if (cost !== null && !(typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) return null;
  return {
    inputTokens: record.inputTokens as number,
    outputTokens: record.outputTokens as number,
    cacheReadTokens: record.cacheReadTokens as number,
    cacheWriteTokens: record.cacheWriteTokens as number,
    costUsd: cost as number | null,
  };
}

/** Adds usage from several runs or batch items. A cost is the sum when every part has one, else null. */
export function sumRunUsage(parts: readonly RunUsage[]): RunUsage {
  const total: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const part of parts) {
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
    total.cacheReadTokens += part.cacheReadTokens;
    total.cacheWriteTokens += part.cacheWriteTokens;
    total.costUsd = total.costUsd === null || part.costUsd === null ? null : total.costUsd + part.costUsd;
  }
  return total;
}
