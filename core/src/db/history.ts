import { Database } from "bun:sqlite";
import { join } from "path";
import { randomUUID } from "crypto";
import { HISTORY_SCHEMA } from "./schema";
import type { FileVersion } from "./types";

export type { FileVersion } from "./types";

export function openHistoryDb(workspacePath: string): Database {
  const db = new Database(join(workspacePath, "history.db"), { create: true });
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
