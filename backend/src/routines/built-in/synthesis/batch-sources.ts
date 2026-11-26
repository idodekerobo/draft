/** One source item as batching sees it. */
export interface BatchableSource {
  id: string;
  version: string;
  contentHash: string;
  /** Length of the item's text, in characters. */
  chars: number;
}

/** Tokens are about four characters of English. A rough count is enough: batching is a cost lever, not a limit. */
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Splits sources, in the order given, into batches that each stay under the token budget. Order is kept so a
 * channel's history reads oldest first. A source bigger than the budget gets a batch of its own.
 */
export function batchSources<T extends BatchableSource>(sources: ReadonlyArray<T>, maxTokensPerBatch: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const source of sources) {
    const size = estimateTokens(source.chars);
    if (current.length > 0 && tokens + size > maxTokensPerBatch) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(source);
    tokens += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
