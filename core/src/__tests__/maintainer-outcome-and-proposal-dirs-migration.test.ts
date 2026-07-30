import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { migrateMaintainerOutcomeAndProposalDirs } from "../migrations/20260729173959_maintainer_outcome_and_proposal_dirs";

const TMP = join("/tmp", `draft-maintainer-outcome-proposal-dirs-migration-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function workspaceDir(profile: string): string {
  return join(TMP, ".draft", "workspaces", profile);
}

function makeWorkspaceDir(profile: string): void {
  mkdirSync(workspaceDir(profile), { recursive: true });
}

describe("maintainer outcome and proposal dirs migration", () => {
  it("moves legacy top-level accepted/ and rejected/ files under proposals/ and removes the old directories", async () => {
    makeWorkspaceDir("acme");
    mkdirSync(join(workspaceDir("acme"), "accepted"), { recursive: true });
    mkdirSync(join(workspaceDir("acme"), "rejected"), { recursive: true });
    writeFileSync(join(workspaceDir("acme"), "accepted", "x.md"), "accepted x");
    writeFileSync(join(workspaceDir("acme"), "rejected", "y.md"), "rejected y");

    await migrateMaintainerOutcomeAndProposalDirs(TMP);

    expect(existsSync(join(workspaceDir("acme"), "proposals", "accepted", "x.md"))).toBe(true);
    expect(existsSync(join(workspaceDir("acme"), "proposals", "rejected", "y.md"))).toBe(true);
    expect(existsSync(join(workspaceDir("acme"), "accepted"))).toBe(false);
    expect(existsSync(join(workspaceDir("acme"), "rejected"))).toBe(false);
  });

  it("never clobbers an existing file already at the new location", async () => {
    makeWorkspaceDir("acme");
    mkdirSync(join(workspaceDir("acme"), "accepted"), { recursive: true });
    mkdirSync(join(workspaceDir("acme"), "proposals", "accepted"), { recursive: true });
    writeFileSync(join(workspaceDir("acme"), "accepted", "x.md"), "legacy content");
    writeFileSync(join(workspaceDir("acme"), "proposals", "accepted", "x.md"), "already migrated content");

    await migrateMaintainerOutcomeAndProposalDirs(TMP);

    expect(readdirSync(join(workspaceDir("acme"), "proposals", "accepted"))).toEqual(["x.md"]);
    expect(readFileSync(join(workspaceDir("acme"), "proposals", "accepted", "x.md"), "utf8")).toBe(
      "already migrated content",
    );
  });

  it("is a no-op for a profile with no legacy accepted/rejected directories", async () => {
    makeWorkspaceDir("clean-profile");

    await expect(migrateMaintainerOutcomeAndProposalDirs(TMP)).resolves.toBeUndefined();
    expect(existsSync(join(workspaceDir("clean-profile"), "proposals"))).toBe(false);
  });

  it("does not block other profiles when one profile's legacy directory can't be fully migrated", async () => {
    makeWorkspaceDir("busy");
    makeWorkspaceDir("clean");
    mkdirSync(join(workspaceDir("busy"), "accepted"), { recursive: true });
    // Leave a non-.md file behind so rmdirSync on "accepted" throws (dir not empty).
    writeFileSync(join(workspaceDir("busy"), "accepted", "notes.txt"), "keep me");
    mkdirSync(join(workspaceDir("clean"), "accepted"), { recursive: true });
    writeFileSync(join(workspaceDir("clean"), "accepted", "z.md"), "z");

    await migrateMaintainerOutcomeAndProposalDirs(TMP);

    expect(existsSync(join(workspaceDir("busy"), "accepted", "notes.txt"))).toBe(true);
    expect(existsSync(join(workspaceDir("clean"), "proposals", "accepted", "z.md"))).toBe(true);
    expect(existsSync(join(workspaceDir("clean"), "accepted"))).toBe(false);
  });
});
