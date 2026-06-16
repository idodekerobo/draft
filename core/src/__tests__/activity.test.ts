import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { openActivityDb, insertRun, queryRuns } from "../db/activity";
import type { ActivityRun } from "../db/activity";

const TMP = `/tmp/draft-core-activity-test-${Date.now()}`;

function makeRun(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: crypto.randomUUID(),
    profile: "default",
    source: "claude-code-session",
    sessionId: "abc12345",
    cwd: "/Users/test/project",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: "success",
    durationMs: 1234,
    proposalsGenerated: 1,
    skipReason: null,
    errorMsg: null,
    ...overrides,
  };
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("openActivityDb", () => {
  it("creates activity.db and runs table on first open", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openActivityDb(TMP);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(rows.some((r: any) => r.name === "runs")).toBe(true);
    db.close();
  });

  it("is idempotent — second open does not throw", () => {
    mkdirSync(TMP, { recursive: true });
    const db1 = openActivityDb(TMP);
    db1.close();
    const db2 = openActivityDb(TMP);
    db2.close();
  });
});

describe("insertRun + queryRuns", () => {
  it("inserts 3 rows and queryRuns returns them newest-first", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openActivityDb(TMP);

    const oldest = makeRun({ startedAt: "2026-06-01T10:00:00.000Z" });
    const middle = makeRun({ startedAt: "2026-06-01T11:00:00.000Z" });
    const newest = makeRun({ startedAt: "2026-06-01T12:00:00.000Z" });

    insertRun(db, oldest);
    insertRun(db, middle);
    insertRun(db, newest);

    const rows = queryRuns(db);
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(newest.id);
    expect(rows[1].id).toBe(middle.id);
    expect(rows[2].id).toBe(oldest.id);

    db.close();
  });

  it("INSERT OR IGNORE — duplicate id is silently dropped", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openActivityDb(TMP);
    const run = makeRun();
    insertRun(db, run);
    insertRun(db, run); // same id
    expect(queryRuns(db)).toHaveLength(1);
    db.close();
  });

  it("queryRuns returns empty array when table is empty", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openActivityDb(TMP);
    expect(queryRuns(db)).toEqual([]);
    db.close();
  });

  it("maps snake_case columns to camelCase fields", () => {
    mkdirSync(TMP, { recursive: true });
    const db = openActivityDb(TMP);
    const run = makeRun({ status: "skipped", skipReason: "abrupt_exit", durationMs: null, endedAt: null });
    insertRun(db, run);
    const [row] = queryRuns(db);
    expect(row.sessionId).toBe(run.sessionId);
    expect(row.startedAt).toBe(run.startedAt);
    expect(row.durationMs).toBeNull();
    expect(row.skipReason).toBe("abrupt_exit");
    expect(row.errorMsg).toBeNull();
    db.close();
  });
});
