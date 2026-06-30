import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DRAFT_ROOT, readDraftConfig, writeDraftConfig } from "../config";
import { migrations, CURRENT_MIGRATION } from "./index";

const MIGRATION_LOCK = join(DRAFT_ROOT, "state", "migration.lock");
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 5 * 60_000;

function lockOwnerIsAlive(): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(MIGRATION_LOCK, "owner.json"), "utf8")) as { pid?: number };
    if (!pid) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockIsStaleByAge(): boolean {
  try {
    return Date.now() - statSync(MIGRATION_LOCK).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireMigrationLock(): Promise<void> {
  mkdirSync(join(DRAFT_ROOT, "state"), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(MIGRATION_LOCK);
      writeFileSync(join(MIGRATION_LOCK, "owner.json"), JSON.stringify({ pid: process.pid }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      if (lockIsStaleByAge() || !lockOwnerIsAlive()) {
        rmSync(MIGRATION_LOCK, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Timed out waiting for another Draft process to finish migrations.");
}

export async function runMigrations(): Promise<void> {
  await acquireMigrationLock();
  try {
    const result = readDraftConfig();
    const config = result.ok ? result.config : { version: "1", tools: {} };
    const lastTs = config.last_migration ?? 0;

    if (lastTs >= CURRENT_MIGRATION) return;

    const pending = Object.keys(migrations)
      .map(Number)
      .filter(ts => ts > lastTs)
      .sort((a, b) => a - b);

    for (const ts of pending) {
      try {
        const migration = migrations[ts];
        if (!migration) continue;
        await migration();
        config.last_migration = ts;
        writeDraftConfig({ ...config });
      } catch (err) {
        console.error(`[draft] migration ${ts} failed:`, err);
        throw err;
      }
    }
  } finally {
    rmSync(MIGRATION_LOCK, { recursive: true, force: true });
  }
}
