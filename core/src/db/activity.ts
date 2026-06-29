import { Database } from "bun:sqlite";
import { join } from "path";
import { ACTIVITY_SCHEMA } from "./schema";
import type { ActivityRun } from "./types";

export type { ActivityRun } from "./types";

export function openActivityDb(workspacePath: string): Database {
  const db = new Database(join(workspacePath, "activity.db"), { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(ACTIVITY_SCHEMA);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
  if (!columns.some(({ name }) => name === "transcript_path")) {
    db.exec("ALTER TABLE runs ADD COLUMN transcript_path TEXT;");
  }
  return db;
}

export function insertRun(db: Database, run: ActivityRun): void {
  db.run(
    `INSERT OR IGNORE INTO runs
       (id, profile, source, session_id, cwd, started_at, ended_at, status,
        duration_ms, proposals_generated, skip_reason, error_msg, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id, run.profile, run.source, run.sessionId, run.cwd,
      run.startedAt, run.endedAt, run.status, run.durationMs,
      run.proposalsGenerated, run.skipReason, run.errorMsg, run.transcriptPath,
    ]
  );
}

export function queryRuns(db: Database, limit = 50): ActivityRun[] {
  return db.query<ActivityRun, [number]>(
    `SELECT id, profile, source,
            session_id          AS sessionId,
            cwd,
            started_at          AS startedAt,
            ended_at            AS endedAt,
            status,
            duration_ms         AS durationMs,
            proposals_generated AS proposalsGenerated,
            skip_reason         AS skipReason,
            error_msg           AS errorMsg,
            transcript_path     AS transcriptPath
     FROM runs ORDER BY started_at DESC LIMIT ?`
  ).all(limit);
}
