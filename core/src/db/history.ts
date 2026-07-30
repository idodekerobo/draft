import { Database } from "bun:sqlite";
import { join } from "path";
import { randomUUID } from "crypto";
import { HISTORY_SCHEMA } from "./schema";
import type { AutomatedRewriteSnapshot, FileVersion } from "./types";

export type { AutomatedRewriteSnapshot, FileVersion } from "./types";

export function openHistoryDb(workspacePath: string): Database {
  const db = new Database(join(workspacePath, "history.db"), { create: true });
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(HISTORY_SCHEMA);
  return db;
}

export function insertFileVersion(
  db: Database,
  version: Omit<FileVersion, "id"> & { id?: string }
): string {
  const id = version.id ?? randomUUID();
  db.run(
    `INSERT INTO file_versions
       (id, file_path, content, created_at, source, author, session_id, published_at, changes_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      version.filePath,
      version.content,
      version.createdAt,
      version.source,
      version.author,
      version.sessionId,
      version.publishedAt,
      version.changesEntryId,
    ]
  );
  return id;
}

export function queryFileVersions(db: Database, filePath: string, limit = 100): FileVersion[] {
  return db.query<FileVersion, [string, number]>(
    `SELECT id, file_path AS filePath, content,
            created_at         AS createdAt,
            source, author,
            session_id         AS sessionId,
            published_at       AS publishedAt,
            changes_entry_id   AS changesEntryId
     FROM file_versions
     WHERE file_path = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(filePath, limit);
}

export function getFileVersion(db: Database, id: string): FileVersion | null {
  return db.query<FileVersion, [string]>(
    `SELECT id, file_path AS filePath, content,
            created_at         AS createdAt,
            source, author,
            session_id         AS sessionId,
            published_at       AS publishedAt,
            changes_entry_id   AS changesEntryId
     FROM file_versions
     WHERE id = ?`
  ).get(id);
}

export function getLatestUnpublishedVersion(db: Database, filePath: string): FileVersion | null {
  return db.query<FileVersion, [string]>(
    `SELECT id, file_path AS filePath, content,
            created_at         AS createdAt,
            source, author,
            session_id         AS sessionId,
            published_at       AS publishedAt,
            changes_entry_id   AS changesEntryId
     FROM file_versions
     WHERE file_path = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(filePath);
}

export function markPublished(
  db: Database,
  id: string,
  publishedAt: string,
  changesEntryId: string
): void {
  db.run(
    `UPDATE file_versions SET published_at = ?, changes_entry_id = ? WHERE id = ?`,
    [publishedAt, changesEntryId, id]
  );
}

export function insertAutomatedRewriteSnapshot(
  db: Database,
  snapshot: Omit<AutomatedRewriteSnapshot, "id">
): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO automated_rewrite_snapshots
       (id, source_event_id, file_path, before_content, after_content, source, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      snapshot.sourceEventId,
      snapshot.filePath,
      snapshot.beforeContent,
      snapshot.afterContent,
      snapshot.source,
      snapshot.summary,
      snapshot.createdAt,
    ]
  );
  return id;
}

export function getAutomatedRewriteSnapshot(
  db: Database,
  sourceEventId: string,
  filePath: string
): AutomatedRewriteSnapshot | null {
  return db.query<AutomatedRewriteSnapshot, [string, string]>(
    `SELECT id,
            source_event_id AS sourceEventId,
            file_path       AS filePath,
            before_content  AS beforeContent,
            after_content   AS afterContent,
            source,
            summary,
            created_at      AS createdAt
     FROM automated_rewrite_snapshots
     WHERE source_event_id = ? AND file_path = ?`
  ).get(sourceEventId, filePath);
}

export function queryAutomatedRewriteDimensions(
  db: Database,
  sourceEventId: string
): string[] {
  const rows = db.query<{ filePath: string }, [string]>(
    `SELECT DISTINCT file_path AS filePath
     FROM automated_rewrite_snapshots
     WHERE source_event_id = ?
     ORDER BY file_path`
  ).all(sourceEventId);

  const dimensions = new Set<string>();
  for (const { filePath } of rows) {
    const match = filePath.match(/^(?:context\/)?([^/]+)\/index\.md$/);
    if (match?.[1]) dimensions.add(match[1]);
  }
  return [...dimensions].sort();
}
