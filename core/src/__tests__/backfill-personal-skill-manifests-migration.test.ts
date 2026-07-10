import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { migrateBackfillPersonalSkillManifests } from "../migrations/20260709195000_backfill_personal_skill_manifests";

const TMP = join("/tmp", `draft-backfill-personal-skills-migration-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function manifestPath(profile: string): string {
  return join(TMP, ".draft", "workspaces", profile, "config", "skill-manifest.json");
}

function personalEntry(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "claude-code:notes",
    name: "notes",
    source_agent: "claude-code",
    source_path: "",
    skill_dir_hash: "sha256:test",
    added_at: now,
    approved_at: now,
    status: "approved",
    synced_to: {},
    removed_at: null,
    kind: "personal",
    ...overrides,
  };
}

function makeWorkspaceDir(profile: string): void {
  mkdirSync(join(TMP, ".draft", "workspaces", profile), { recursive: true });
}

describe("backfill personal skill manifests migration", () => {
  it("backfills other profiles with a verified, on-disk personal skill approval", async () => {
    const source = join(TMP, "sources", "notes");
    mkdirSync(source, { recursive: true });
    const codexLink = join(TMP, "codex-skills", "notes");
    mkdirSync(join(codexLink, ".."), { recursive: true });
    symlinkSync(resolve(source), codexLink);

    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({
          source_path: resolve(source),
          synced_to: { codex: { target_name: "notes", symlink_path: codexLink, synced_at: new Date().toISOString() } },
        }),
      },
    });

    await migrateBackfillPersonalSkillManifests(TMP);

    const otherManifest = readJson(manifestPath("other"));
    expect(otherManifest.skills["claude-code:notes"]).toMatchObject({ status: "approved", kind: "personal" });
  });

  it("never backfills a pending or empty-synced_to personal entry", async () => {
    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:pending-notes": personalEntry({
          id: "claude-code:pending-notes", name: "pending-notes", status: "pending", approved_at: null,
        }),
        "claude-code:no-sync-notes": personalEntry({
          id: "claude-code:no-sync-notes", name: "no-sync-notes", synced_to: {},
        }),
      },
    });

    await migrateBackfillPersonalSkillManifests(TMP);

    // Nothing valid to backfill — "other"'s manifest is never even written.
    expect(existsSync(manifestPath("other"))).toBe(false);
  });

  it("skips backfill entirely when two profiles disagree about the same skill id's source", async () => {
    const sourceA = join(TMP, "sources", "a");
    const sourceB = join(TMP, "sources", "b");
    mkdirSync(sourceA, { recursive: true });
    mkdirSync(sourceB, { recursive: true });
    const linkA = join(TMP, "acme-codex-skills", "notes");
    const linkB = join(TMP, "profileb-codex-skills", "notes");
    mkdirSync(join(linkA, ".."), { recursive: true });
    mkdirSync(join(linkB, ".."), { recursive: true });
    symlinkSync(resolve(sourceA), linkA);
    symlinkSync(resolve(sourceB), linkB);

    makeWorkspaceDir("acme");
    makeWorkspaceDir("profileb");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({
          source_path: resolve(sourceA),
          synced_to: { codex: { target_name: "notes", symlink_path: linkA, synced_at: new Date().toISOString() } },
        }),
      },
    });
    writeJson(manifestPath("profileb"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({
          source_path: resolve(sourceB),
          synced_to: { codex: { target_name: "notes", symlink_path: linkB, synced_at: new Date().toISOString() } },
        }),
      },
    });

    await migrateBackfillPersonalSkillManifests(TMP);

    // Conflicting id — dropped from the backfill set entirely, so "other" never gets it.
    expect(existsSync(manifestPath("other"))).toBe(false);
    // Existing profiles' own entries are untouched.
    expect(readJson(manifestPath("acme")).skills["claude-code:notes"].source_path).toBe(resolve(sourceA));
    expect(readJson(manifestPath("profileb")).skills["claude-code:notes"].source_path).toBe(resolve(sourceB));
  });

  it("never overwrites a profile's existing entry of any status, including its own tombstone", async () => {
    const source = join(TMP, "sources", "notes");
    mkdirSync(source, { recursive: true });
    const codexLink = join(TMP, "codex-skills2", "notes");
    mkdirSync(join(codexLink, ".."), { recursive: true });
    symlinkSync(resolve(source), codexLink);

    makeWorkspaceDir("acme");
    makeWorkspaceDir("tombstoned-profile");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({
          source_path: resolve(source),
          synced_to: { codex: { target_name: "notes", symlink_path: codexLink, synced_at: new Date().toISOString() } },
        }),
      },
    });
    writeJson(manifestPath("tombstoned-profile"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({ status: "tombstoned", removed_at: new Date().toISOString() }),
      },
    });

    await migrateBackfillPersonalSkillManifests(TMP);

    const tombstonedProfileManifest = readJson(manifestPath("tombstoned-profile"));
    expect(tombstonedProfileManifest.skills["claude-code:notes"].status).toBe("tombstoned");
  });

  it("is idempotent — re-running the migration is a no-op", async () => {
    const source = join(TMP, "sources", "notes");
    mkdirSync(source, { recursive: true });
    const codexLink = join(TMP, "codex-skills3", "notes");
    mkdirSync(join(codexLink, ".."), { recursive: true });
    symlinkSync(resolve(source), codexLink);

    makeWorkspaceDir("acme");
    makeWorkspaceDir("other");
    writeJson(manifestPath("acme"), {
      version: 5, schema_version: 5, min_reader_version: 1, name_conflicts: {},
      skills: {
        "claude-code:notes": personalEntry({
          source_path: resolve(source),
          synced_to: { codex: { target_name: "notes", symlink_path: codexLink, synced_at: new Date().toISOString() } },
        }),
      },
    });

    await migrateBackfillPersonalSkillManifests(TMP);
    const firstRun = readJson(manifestPath("other"));
    await migrateBackfillPersonalSkillManifests(TMP);
    const secondRun = readJson(manifestPath("other"));

    expect(secondRun).toEqual(firstRun);
  });
});
