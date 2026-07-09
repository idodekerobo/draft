import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import {
  openHistoryDb,
  insertFileVersion,
  queryFileVersions,
  getFileVersion,
  getLatestUnpublishedVersion,
  markPublished,
} from "../db/history";
import type { FileVersion } from "../db/history";

const TMP = `/tmp/draft-core-history-test-${Date.now()}`;

function makeVersion(overrides: Partial<Omit<FileVersion, "id">> = {}): Omit<FileVersion, "id"> {
  return {
    filePath: "product/index.md",
    content: "# Product\n\nSome content.",
    createdAt: new Date().toISOString(),
    source: "human-edit",
    author: "idodekerobo",
    sessionId: null,
    publishedAt: null,
    changesEntryId: null,
    ...overrides,
  };
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("openHistoryDb", () => {
  it("creates history.db and file_versions table on first open", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(rows.some((r: any) => r.name === "file_versions")).toBe(true);
    db.close();
  });

  it("is idempotent — second open does not throw", () => {
    mkdirSync(TMP, { recursive: true });
    const db1 = openHistoryDb(TMP);
    db1.close();
    const db2 = openHistoryDb(TMP);
    db2.close();
  });
});

describe("insertFileVersion + queryFileVersions", () => {
  it("inserts 3 versions for a file and returns them newest-first", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);

    const oldest = makeVersion({ createdAt: "2026-06-01T10:00:00.000Z", content: "v1" });
    const middle = makeVersion({ createdAt: "2026-06-01T11:00:00.000Z", content: "v2" });
    const newest = makeVersion({ createdAt: "2026-06-01T12:00:00.000Z", content: "v3" });

    const oldestId = insertFileVersion(db, oldest);
    const middleId = insertFileVersion(db, middle);
    const newestId = insertFileVersion(db, newest);

    const rows = queryFileVersions(db, "product/index.md");
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(newestId);
    expect(rows[1].id).toBe(middleId);
    expect(rows[2].id).toBe(oldestId);

    db.close();
  });

  it("scopes queryFileVersions to the given file_path", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    insertFileVersion(db, makeVersion({ filePath: "product/index.md" }));
    insertFileVersion(db, makeVersion({ filePath: "team/index.md" }));
    expect(queryFileVersions(db, "product/index.md")).toHaveLength(1);
    expect(queryFileVersions(db, "team/index.md")).toHaveLength(1);
    expect(queryFileVersions(db, "nonexistent.md")).toEqual([]);
    db.close();
  });

  it("maps snake_case columns to camelCase fields", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    const version = makeVersion({ source: "team-load", author: null, sessionId: "sess-1" });
    insertFileVersion(db, version);
    const [row] = queryFileVersions(db, "product/index.md");
    expect(row.filePath).toBe(version.filePath);
    expect(row.createdAt).toBe(version.createdAt);
    expect(row.source).toBe("team-load");
    expect(row.author).toBeNull();
    expect(row.sessionId).toBe("sess-1");
    expect(row.publishedAt).toBeNull();
    expect(row.changesEntryId).toBeNull();
    db.close();
  });
});

describe("getFileVersion", () => {
  it("returns the version by id", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    const id = insertFileVersion(db, makeVersion({ content: "hello" }));
    const version = getFileVersion(db, id);
    expect(version?.content).toBe("hello");
    db.close();
  });

  it("returns null for an unknown id", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    expect(getFileVersion(db, "does-not-exist")).toBeNull();
    db.close();
  });
});

describe("getLatestUnpublishedVersion + markPublished", () => {
  it("returns the most recent version for a file", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    insertFileVersion(db, makeVersion({ createdAt: "2026-06-01T10:00:00.000Z", content: "v1" }));
    const latestId = insertFileVersion(db, makeVersion({ createdAt: "2026-06-01T11:00:00.000Z", content: "v2" }));

    const latest = getLatestUnpublishedVersion(db, "product/index.md");
    expect(latest?.id).toBe(latestId);
    expect(latest?.content).toBe("v2");
    db.close();
  });

  it("markPublished sets published_at and changes_entry_id without inserting a new row", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openHistoryDb(TMP);
    const id = insertFileVersion(db, makeVersion());

    markPublished(db, id, "2026-06-02T00:00:00.000Z", "changes-entry-1");

    const rows = queryFileVersions(db, "product/index.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].publishedAt).toBe("2026-06-02T00:00:00.000Z");
    expect(rows[0].changesEntryId).toBe("changes-entry-1");
    db.close();
  });
});
