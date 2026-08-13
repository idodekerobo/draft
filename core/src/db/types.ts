export interface FileVersion {
  id: string;
  filePath: string;         // relative path under context/, e.g. "product/index.md"
  content: string;          // full markdown snapshot, frontmatter included
  createdAt: string;        // ISO 8601
  source: "human-edit" | "team-load" | "initial" | "automated-maintainer";
  author: string | null;
  sessionId: string | null; // reserved for future CRDT actor attribution
  publishedAt: string | null;
  changesEntryId: string | null;
}

export interface AutomatedRewriteSnapshot {
  id: string;
  sourceEventId: string;
  filePath: string;         // relative to context/, e.g. "product/index.md"
  beforeContent: string;
  afterContent: string;
  source: string;
  summary: string;
  createdAt: string;        // ISO 8601
}
