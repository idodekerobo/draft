import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import {
  applyAutomatedMaintainerOutput,
  type TrustedMaintainerMetadata,
} from "../automated-maintainer";
import type { MaintainerOutput } from "../maintainer";
import {
  getAutomatedRewriteSnapshot,
  openHistoryDb,
  queryFileVersions,
} from "../db/history";

const ROOT = `/tmp/draft-automated-maintainer-${process.pid}-${Date.now()}`;
let sequence = 0;

const trusted: TrustedMaintainerMetadata = {
  session_id: "trusted-session",
  input_source: "trusted-source",
  synthesized_by: "trusted-synthesizer",
  timestamp: "2026-07-29T12:00:00Z",
  profile: "trusted-profile",
};

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function workspace(): string {
  const path = join(ROOT, String(sequence++));
  mkdirSync(path, { recursive: true });
  return path;
}

function contextFile(workspacePath: string, dimension: string, content: string): string {
  const directory = join(workspacePath, "context", dimension);
  mkdirSync(join(directory, "log"), { recursive: true });
  const path = join(directory, "index.md");
  writeFileSync(path, content);
  return path;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rewrite(
  file: string,
  before: string,
  after: string,
  metadata: Partial<TrustedMaintainerMetadata> = {},
): MaintainerOutput {
  return {
    outcome: "rewrite",
    rewrites: [
      {
        file,
        base_sha256: hash(before),
        summary: `Rewrite ${file}`,
        content: after,
        removals: [{ claim: "Old claim", reason: "Superseded by trusted evidence" }],
      },
    ],
    session_id: "model-session",
    input_source: "model-source",
    synthesized_by: "model-synthesizer",
    timestamp: "1999-01-01T00:00:00Z",
    profile: "model-profile",
    ...metadata,
  };
}

describe("applyAutomatedMaintainerOutput", () => {
  it("returns durable no_change success without touching the workspace", () => {
    const path = join(ROOT, "does-not-exist");
    const result = applyAutomatedMaintainerOutput(
      {
        outcome: "no_change",
        session_id: "untrusted",
        timestamp: "untrusted",
      },
      trusted,
      path,
    );

    expect(result).toEqual({
      status: "success",
      outcome: "no_change",
      flaggedPath: null,
    });
    expect(existsSync(path)).toBe(false);
  });

  it("stages needs_input prominently under proposals/flagged with trusted metadata", () => {
    const path = workspace();
    const result = applyAutomatedMaintainerOutput(
      {
        outcome: "needs_input",
        needs_input_reason: "Roadmap A conflicts with roadmap B.",
        session_id: "model-session",
        input_source: "model-source",
        synthesized_by: "model-synthesizer",
        timestamp: "model-time",
        profile: "model-profile",
      },
      trusted,
      path,
    );

    expect(result.status).toBe("flagged");
    expect(result.outcome).toBe("needs_input");
    const flaggedPath = result.flaggedPath!;
    const proposal = readFileSync(flaggedPath, "utf8");
    expect(flaggedPath).toContain(join("proposals", "flagged"));
    expect(proposal).toContain("# ⚠️ HUMAN REVIEW REQUIRED");
    expect(proposal).toContain("Roadmap A conflicts with roadmap B.");
    expect(proposal).toContain("outcome: needs_input");
    expect(proposal).toContain(
      'needs_input_reason: "Roadmap A conflicts with roadmap B."',
    );
    for (const value of Object.values(trusted)) expect(proposal).toContain(value);
    expect(proposal).not.toContain("model-source");
    expect(existsSync(join(path, "context"))).toBe(false);
    expect(existsSync(join(path, "history.db"))).toBe(false);
  });

  it("flags stale snapshots and makes no context, log, or history writes", () => {
    const path = workspace();
    const current = "# Current\n";
    const target = contextFile(path, "product", current);
    const output = rewrite("context/product/index.md", "# Old snapshot\n", "# Proposed\n");

    const result = applyAutomatedMaintainerOutput(output, trusted, path);

    expect(result.status).toBe("flagged");
    expect(result.outcome).toBe("stale");
    expect(readFileSync(target, "utf8")).toBe(current);
    expect(readdirSync(join(path, "context", "product", "log"))).toEqual([]);
    expect(existsSync(join(path, "history.db"))).toBe(false);
    const proposal = readFileSync(result.flaggedPath!, "utf8");
    expect(proposal).toContain("snapshot is stale");
    expect(proposal).toContain("outcome: needs_input");
    expect(proposal).toContain("needs_input_reason:");
    expect(proposal).toContain('flagged_reason: "stale"');
    expect(proposal).toContain("# Proposed");
  });

  it("atomically rewrites and stores exact snapshots, final version, and trusted log", () => {
    const path = workspace();
    const before = "# Product\n\nOld state.\n";
    const after = "# Product\n\nNew durable state.\n";
    const target = contextFile(path, "product", before);

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/product/index.md", before, after),
      trusted,
      path,
    );

    expect(result).toEqual({
      status: "success",
      outcome: "rewrite",
      flaggedPath: null,
    });
    expect(readFileSync(target, "utf8")).toBe(after);

    const db = openHistoryDb(path);
    const snapshot = getAutomatedRewriteSnapshot(
      db,
      trusted.session_id,
      "product/index.md",
    );
    expect(snapshot?.beforeContent).toBe(before);
    expect(snapshot?.afterContent).toBe(after);
    expect(snapshot?.source).toBe(trusted.input_source);
    const versions = queryFileVersions(db, "product/index.md");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      content: after,
      source: "automated-maintainer",
      author: trusted.synthesized_by,
      sessionId: trusted.session_id,
      createdAt: trusted.timestamp,
    });
    db.close();

    const entries = readdirSync(join(path, "context", "product", "log"));
    expect(entries).toHaveLength(1);
    const log = readFileSync(
      join(path, "context", "product", "log", entries[0]!),
      "utf8",
    );
    for (const value of Object.values(trusted)) expect(log).toContain(value);
    expect(log).toContain(`before_sha256: "${hash(before)}"`);
    expect(log).toContain(`after_sha256: "${hash(after)}"`);
    expect(log).not.toContain("model-source");
    expect(log).toContain("Old claim");
  });

  it("rolls back every file, log, and history mutation when a later history insert fails", () => {
    const path = workspace();
    const first = "# First\n";
    const second = "# Second\n";
    const third = "# Third\n";
    const target = contextFile(path, "priorities", first);

    applyAutomatedMaintainerOutput(
      rewrite("context/priorities/index.md", first, second),
      trusted,
      path,
    );
    const logsBefore = readdirSync(join(path, "context", "priorities", "log"));

    expect(() =>
      applyAutomatedMaintainerOutput(
        rewrite("context/priorities/index.md", second, third),
        trusted,
        path,
      )
    ).toThrow();

    expect(readFileSync(target, "utf8")).toBe(second);
    expect(readdirSync(join(path, "context", "priorities", "log"))).toEqual(logsBefore);
    const db = openHistoryDb(path);
    expect(queryFileVersions(db, "priorities/index.md")).toHaveLength(1);
    expect(
      getAutomatedRewriteSnapshot(db, trusted.session_id, "priorities/index.md")
        ?.afterContent,
    ).toBe(second);
    db.close();
  });

  it("restores a rewritten file when logging fails, leaving history.db in place", () => {
    const path = workspace();
    const before = "# Company\n";
    const after = "# Changed company\n";
    const target = contextFile(path, "company", before);
    rmSync(join(path, "context", "company", "log"), { recursive: true });
    writeFileSync(join(path, "context", "company", "log"), "not a directory");

    expect(() =>
      applyAutomatedMaintainerOutput(
        rewrite("context/company/index.md", before, after),
        trusted,
        path,
      )
    ).toThrow();

    expect(readFileSync(target, "utf8")).toBe(before);
    expect(readFileSync(join(path, "context", "company", "log"), "utf8")).toBe(
      "not a directory",
    );
    // openHistoryDb is idempotent; a shared database is never deleted on a
    // failed insert — that would be a worse hazard than a stray empty file.
    const db = openHistoryDb(path);
    expect(queryFileVersions(db, "company/index.md")).toHaveLength(0);
    db.close();
  });

  it("returns locked without reading or mutating targets when a live owner holds the lock", () => {
    const path = workspace();
    const before = "# Team\n";
    const target = contextFile(path, "team", before);
    const lockDir = join(path, ".automated-maintainer.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ token: "other", pid: process.pid, acquired_at: new Date().toISOString() }),
    );

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/team/index.md", before, "# New team\n"),
      trusted,
      path,
    );

    expect(result).toEqual({
      status: "locked",
      outcome: "rewrite",
      flaggedPath: null,
    });
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(readdirSync(join(path, "context", "team", "log"))).toEqual([]);
    expect(existsSync(join(path, "history.db"))).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  it("steals a lock whose recorded pid is dead and completes the rewrite", () => {
    const path = workspace();
    const before = "# Team\n";
    const target = contextFile(path, "team", before);
    const lockDir = join(path, ".automated-maintainer.lock");
    mkdirSync(lockDir);
    // pid 2**30 is astronomically unlikely to be alive.
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ token: "dead-owner", pid: 2 ** 30, acquired_at: new Date().toISOString() }),
    );

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/team/index.md", before, "# New team\n"),
      trusted,
      path,
    );

    expect(result).toEqual({ status: "success", outcome: "rewrite", flaggedPath: null });
    expect(readFileSync(target, "utf8")).toBe("# New team\n");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("steals a lock held by a live pid whose lease has expired", () => {
    const path = workspace();
    const before = "# Team\n";
    const target = contextFile(path, "team", before);
    const lockDir = join(path, ".automated-maintainer.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ token: "stale-owner", pid: process.pid, acquired_at: "2020-01-01T00:00:00Z" }),
    );

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/team/index.md", before, "# New team\n"),
      trusted,
      path,
    );

    expect(result).toEqual({ status: "success", outcome: "rewrite", flaggedPath: null });
    expect(readFileSync(target, "utf8")).toBe("# New team\n");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("steals a malformed/legacy bare-token owner file", () => {
    const path = workspace();
    const before = "# Team\n";
    const target = contextFile(path, "team", before);
    const lockDir = join(path, ".automated-maintainer.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner"), "legacy-bare-token");

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/team/index.md", before, "# New team\n"),
      trusted,
      path,
    );

    expect(result).toEqual({ status: "success", outcome: "rewrite", flaggedPath: null });
    expect(readFileSync(target, "utf8")).toBe("# New team\n");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("flags a rewrite target deleted after the snapshot was taken, naming the missing file", () => {
    const path = workspace();
    const before = "# Team\n";
    contextFile(path, "team", before);
    rmSync(join(path, "context", "team", "index.md"));

    const result = applyAutomatedMaintainerOutput(
      rewrite("context/team/index.md", before, "# New team\n"),
      trusted,
      path,
    );

    expect(result.status).toBe("flagged");
    expect(result.outcome).toBe("stale");
    const proposal = readFileSync(result.flaggedPath!, "utf8");
    expect(proposal).toContain("context/team/index.md: the target file no longer exists.");
    expect(existsSync(join(path, "history.db"))).toBe(false);
  });

  it("rejects a symlink target that escapes the workspace", () => {
    const path = workspace();
    const outside = join(ROOT, "outside-target.md");
    writeFileSync(outside, "# Outside\n");
    const linkedDirectory = join(path, "context", "linked");
    mkdirSync(linkedDirectory, { recursive: true });
    symlinkSync(outside, join(linkedDirectory, "index.md"));

    expect(() =>
      applyAutomatedMaintainerOutput(
        rewrite("context/linked/index.md", "# Outside\n", "# Changed\n"),
        trusted,
        path,
      )
    ).toThrow(/escapes workspace/);
    expect(readFileSync(outside, "utf8")).toBe("# Outside\n");
  });

  it("rejects a rewrite target that is not a regular file", () => {
    const path = workspace();
    const directoryAsTarget = join(path, "context", "notafile", "index.md");
    mkdirSync(directoryAsTarget, { recursive: true });

    expect(() =>
      applyAutomatedMaintainerOutput(
        rewrite("context/notafile/index.md", "# Anything\n", "# Changed\n"),
        trusted,
        path,
      )
    ).toThrow(/regular file/);
  });

  it("validates every hash before writing any file", () => {
    const path = workspace();
    const product = contextFile(path, "product", "# Product\n");
    const team = contextFile(path, "team", "# Team current\n");
    const output: MaintainerOutput = {
      outcome: "rewrite",
      rewrites: [
        {
          file: "context/product/index.md",
          base_sha256: hash("# Product\n"),
          summary: "Product",
          content: "# Product changed\n",
        },
        {
          file: "context/team/index.md",
          base_sha256: hash("# Team stale\n"),
          summary: "Team",
          content: "# Team changed\n",
        },
      ],
    };

    const result = applyAutomatedMaintainerOutput(output, trusted, path);

    expect(result.outcome).toBe("stale");
    expect(readFileSync(product, "utf8")).toBe("# Product\n");
    expect(readFileSync(team, "utf8")).toBe("# Team current\n");
  });

  it("uses a trusted job ID as the source event when no session ID exists", () => {
    const path = workspace();
    const before = "# Product\n";
    const after = "# Product from job\n";
    contextFile(path, "product", before);
    const jobMetadata: TrustedMaintainerMetadata = {
      job_id: "job-456",
      input_source: "scheduled-job",
      synthesized_by: "maintainer-v2",
      timestamp: trusted.timestamp,
      profile: trusted.profile,
    };

    applyAutomatedMaintainerOutput(
      rewrite("context/product/index.md", before, after),
      jobMetadata,
      path,
    );

    const db = openHistoryDb(path);
    expect(
      getAutomatedRewriteSnapshot(db, "job-456", "product/index.md")?.afterContent,
    ).toBe(after);
    expect(queryFileVersions(db, "product/index.md")[0]?.sessionId).toBe("job-456");
    db.close();
    const logName = readdirSync(join(path, "context", "product", "log"))[0]!;
    const log = readFileSync(join(path, "context", "product", "log", logName), "utf8");
    expect(log).toContain('job_id: "job-456"');
    expect(log).not.toContain("model-source");
  });
});
