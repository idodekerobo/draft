import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export async function migrateMaintainerOutcomeAndProposalDirs(home: string = homedir()): Promise<void> {
  const workspacesDir = join(home, ".draft", "workspaces");
  let profiles: string[] = [];
  try {
    profiles = readdirSync(workspacesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }

  for (const profile of profiles) {
    const workspace = join(workspacesDir, profile);
    const dbPath = join(workspace, "activity.db");
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath);
        try {
          const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
          if (!columns.some(({ name }) => name === "maintainer_outcome")) {
            db.exec(`ALTER TABLE runs ADD COLUMN maintainer_outcome TEXT CHECK (
              maintainer_outcome IN ('no_change', 'rewrite', 'needs_input')
              OR maintainer_outcome IS NULL
            );`);
          }
        } finally {
          db.close();
        }
      } catch {
        // A malformed or inaccessible legacy database should not block other profiles.
      }
    }

    for (const name of ["accepted", "rejected"]) {
      const from = join(workspace, name);
      const to = join(workspace, "proposals", name);
      if (!existsSync(from)) continue;
      try {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from).filter(f => f.endsWith(".md"))) {
          const target = join(to, entry);
          if (existsSync(target)) continue; // never clobber the new location
          renameSync(join(from, entry), target);
        }
        rmdirSync(from); // throws if non-empty — fine, skip it
      } catch {
        // A partially-migrated or busy workspace must not block other profiles.
      }
    }
  }
}

export default function migrate(): Promise<void> {
  return migrateMaintainerOutcomeAndProposalDirs();
}
