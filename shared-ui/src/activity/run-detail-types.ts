/** One run's usage, as the harness reported it. */
export interface RunUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the harness gives no cost. */
  costUsd: number | null;
}

export type StepStatus = "waiting" | "running" | "done" | "failed" | "skipped" | "not_run";

/** One step run: a step's work on one item, or one retry of it. */
export interface StepRunDetail {
  id: string;
  status: string;
  attempt: number;
  /** What it worked on, such as a document path. Empty for a step that runs once. */
  label: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: string | null;
  failureCode: string | null;
  usage: RunUsageSummary | null;
  documentsChanged: string[];
  hasTranscript: boolean;
}

export interface RunStepDetail {
  key: string;
  status: StepStatus;
  runs: StepRunDetail[];
}

/** Shape of GET /workspaces/:id/runs/:runId. */
export interface RunDetail {
  id: string;
  kind: "synthesis" | "routine" | string;
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  summary: string | null;
  routineId: string | null;
  routineTitle: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  /** The step that stopped the run, when one did. */
  failedStep: string | null;
  usage: RunUsageSummary | null;
  documentsChanged: string[];
  steps: RunStepDetail[];
}

/** Shape of GET /workspaces/:id/runs/:runId/transcript. */
export interface StepRunTranscript {
  lines: string[];
  truncated: boolean;
}
