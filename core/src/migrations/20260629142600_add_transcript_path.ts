import { Database } from "bun:sqlite";
import { join } from "path";
import { getActiveProfile, getWorkspacePath, WORKSPACES_DIR } from "../config";
import { readdirSync, existsSync } from "fs";

export default async function migrate(): Promise<void> {
  // Apply to every profile's activity.db
  let profiles: string[] = [];
  try {
    profiles = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    // workspaces dir doesn't exist yet — nothing to migrate
    return;
  }

  for (const profile of profiles) {
    const dbPath = join(getWorkspacePath(profile), "activity.db");
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath);
      db.exec("ALTER TABLE runs ADD COLUMN transcript_path TEXT;");
      db.close();
    } catch {
      // Column likely already exists — safe to ignore
    }
  }
}
