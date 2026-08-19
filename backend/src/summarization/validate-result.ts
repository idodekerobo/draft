import type { SessionSummaryPayload, ValidatedSummaryResultItem } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(raw: unknown, sessionId: string): SessionSummaryPayload {
  if (!isObject(raw)) {
    throw new Error(`summary payload must be a JSON object: ${sessionId}`);
  }
  const { who, project, outcome, keyDecisions } = raw;
  if (typeof who !== "string" || !who.trim()) {
    throw new Error(`summary payload "who" must be a nonempty string: ${sessionId}`);
  }
  if (typeof project !== "string" || !project.trim()) {
    throw new Error(`summary payload "project" must be a nonempty string: ${sessionId}`);
  }
  if (typeof outcome !== "string" || !outcome.trim()) {
    throw new Error(`summary payload "outcome" must be a nonempty string: ${sessionId}`);
  }
  if (!Array.isArray(keyDecisions) || keyDecisions.some((entry) => typeof entry !== "string")) {
    throw new Error(`summary payload "keyDecisions" must be an array of strings: ${sessionId}`);
  }
  return { who, project, outcome, keyDecisions };
}

function parseItem(raw: unknown): ValidatedSummaryResultItem {
  if (!isObject(raw) || typeof raw.sessionId !== "string" || !raw.sessionId) {
    throw new Error("batch result item must have a nonempty sessionId");
  }
  if (typeof raw.ok !== "boolean") {
    throw new Error(`batch result item "ok" must be a boolean: ${raw.sessionId}`);
  }
  if (raw.ok) {
    return { sessionId: raw.sessionId, ok: true, payload: parsePayload(raw.payload, raw.sessionId) };
  }
  return { sessionId: raw.sessionId, ok: false, error: raw.error };
}

export function validateSummarizationResult(rawResult: unknown): ValidatedSummaryResultItem[] {
  if (!isObject(rawResult) || !Array.isArray(rawResult.items)) {
    throw new Error("summarization batch result must be a JSON object with an items array");
  }
  const seen = new Set<string>();
  const items = rawResult.items.map((raw) => {
    const item = parseItem(raw);
    if (seen.has(item.sessionId)) {
      throw new Error(`duplicate sessionId in batch result: ${item.sessionId}`);
    }
    seen.add(item.sessionId);
    return item;
  });
  return items;
}
