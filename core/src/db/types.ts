export interface ActivityRun {
  id: string;
  profile: string;
  source: string;
  sessionId: string | null;
  cwd: string | null;
  startedAt: string;        // ISO 8601
  endedAt: string | null;
  status: "success" | "failed" | "skipped" | "timeout";
  durationMs: number | null;
  proposalsGenerated: number;
  skipReason: string | null;
  errorMsg: string | null;
  transcriptPath: string | null;
}
