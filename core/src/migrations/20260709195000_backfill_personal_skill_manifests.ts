import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";

// Local, hand-rolled types/read/write — deliberately decoupled from scanner.ts's
// live SkillManifest types (matching 20260629213430_workspace_scoped_manifests.ts's
// precedent), so this migration doesn't break if app-code signatures evolve later.

type SkillManifestSyncEntryV5 = {
  target_name: string;
  symlink_path: string;
  synced_at: string;
};

type SkillManifestEntryV5 = {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  source_path: string;
  skill_dir_hash: string;
  added_at: string;
  approved_at: string | null;
  status: "pending" | "approved" | "conflict" | "tombstoned";
  synced_to: Partial<Record<"claude-code" | "codex", SkillManifestSyncEntryV5>>;
  removed_at: string | null;
  kind: "personal" | "team";
  install_state?: string;
  conflict_reason?: string;
};

type SkillManifestV5 = {
  version: 5;
  schema_version: 5;
  min_reader_version: 1;
  skills: Record<string, SkillManifestEntryV5>;
  name_conflicts: Record<string, unknown>;
};

function readManifestTolerant(path: string): SkillManifestV5 {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema_version === 5) return parsed as SkillManifestV5;
  } catch { /* missing or malformed — treat as empty */ }
  return { version: 5, schema_version: 5, min_reader_version: 1, skills: {}, name_conflicts: {} };
}

function writeManifestAtomic(manifest: SkillManifestV5, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** True if `linkPath` is a live symlink whose realpath resolves to `expectedSourcePath`. */
function isOwnedSymlink(linkPath: string, expectedSourcePath: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const actual = realpathSync(resolve(dirname(linkPath), readlinkSync(linkPath)));
    const expected = realpathSync(expectedSourcePath);
    return actual === expected;
  } catch {
    return false;
  }
}

/** True if both paths resolve to the same real location. Unresolvable paths never match (conservative default). */
function sameRealSource(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Backfill every existing profile with approved personal-skill entries for
 * skills that are currently verified as correctly symlinked on disk.
 *
 * Why this is required: today every profile silently benefits from whatever
 * personal skills happen to be globally symlinked, regardless of which
 * profile's manifest recorded the approval. Once installPersonalSkills/
 * uninstallPersonalSkills start enforcing per-profile scoping on switch, any
 * profile that never itself approved a currently-existing symlink would lose
 * it the next time it's activated. This migration is pure additive backfill —
 * it never removes or tombstones anything, and never overwrites an existing
 * opinion (of any status, including a profile's own tombstone) about a skill.
 */
export async function migrateBackfillPersonalSkillManifests(home: string = homedir()): Promise<void> {
  const workspacesDir = join(home, ".draft", "workspaces");
  let profiles: string[] = [];
  try {
    profiles = readdirSync(workspacesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  // Collect every currently-valid personal approval across all profiles.
  const allApproved = new Map<string, SkillManifestEntryV5>();
  const conflicting = new Set<string>(); // ids where profiles disagree — never backfilled

  for (const profile of profiles) {
    const manifestPath = join(workspacesDir, profile, "config", "skill-manifest.json");
    const manifest = readManifestTolerant(manifestPath);
    for (const [id, entry] of Object.entries(manifest.skills)) {
      if (entry.kind !== "personal") continue;
      if (entry.status !== "approved" || entry.removed_at !== null) continue;

      const syncEntries = Object.values(entry.synced_to);
      if (syncEntries.length === 0) continue; // no linked target — nothing to verify or trust
      const stillValid = syncEntries.every((s) => isOwnedSymlink(s.symlink_path, entry.source_path));
      if (!stillValid) continue;

      const existing = allApproved.get(id);
      if (existing && !sameRealSource(existing.source_path, entry.source_path)) {
        // Two profiles both approved this id but disagree about its source —
        // do not silently pick a winner. Drop it from the backfill set
        // entirely; each profile keeps its own existing (divergent) entry.
        // Compared by realpath, not raw string equality: two profiles whose
        // entries point at the same real skill through different path
        // spellings (e.g. one via a symlinked alias) must not be treated as
        // conflicting just because the strings differ.
        conflicting.add(id);
        continue;
      }
      allApproved.set(id, entry);
    }
  }
  for (const id of conflicting) allApproved.delete(id);

  // Backfill: every profile gets an entry for every currently-valid,
  // non-conflicting id it doesn't already have ANY opinion about (approved,
  // pending, conflict, OR tombstoned — never overwrite an existing entry of
  // any status, including a profile's own tombstone).
  for (const profile of profiles) {
    const manifestPath = join(workspacesDir, profile, "config", "skill-manifest.json");
    const manifest = readManifestTolerant(manifestPath);
    let dirty = false;
    for (const [id, entry] of allApproved) {
      if (manifest.skills[id]) continue; // any existing opinion, including tombstoned, wins
      manifest.skills[id] = { ...entry };
      dirty = true;
    }
    if (dirty) writeManifestAtomic(manifest, manifestPath);
  }
}

export default function migrate(): Promise<void> {
  return migrateBackfillPersonalSkillManifests();
}
