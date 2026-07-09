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

export interface FileVersion {
  id: string;
  filePath: string;         // relative path under context/, e.g. "product/index.md"
  content: string;          // full markdown snapshot, frontmatter included
  createdAt: string;        // ISO 8601
  source: "human-edit" | "team-load" | "initial";
  author: string | null;
  sessionId: string | null; // reserved for future CRDT actor attribution
  publishedAt: string | null;
  changesEntryId: string | null;
}
