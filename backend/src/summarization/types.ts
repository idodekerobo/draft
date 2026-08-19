export interface SessionSummaryPayload {
  who: string;
  project: string;
  outcome: string;
  keyDecisions: string[];
}

export interface SummaryManifestEntry {
  id: string;
  transcriptPath: string;
}

export interface SummaryResultItem {
  sessionId: string;
  ok: boolean;
  payload?: SessionSummaryPayload;
  error?: unknown;
}

export interface ValidatedSummaryResultItem {
  sessionId: string;
  ok: boolean;
  payload?: SessionSummaryPayload;
  error?: unknown;
}
