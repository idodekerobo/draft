import {
  closeSync,
  constants,
  existsSync,
  fdatasyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname, join, relative, sep } from "path";
import type { Database } from "bun:sqlite";
import type { MaintainerOutput, MaintainerRewrite } from "./maintainer";
import {
  insertAutomatedRewriteSnapshot,
  insertFileVersion,
  openHistoryDb,
} from "./db/history";

interface TrustedMaintainerMetadataCommon {
  input_source: string;
  synthesized_by: string;
  timestamp: string;
  profile: string;
}

export type TrustedMaintainerMetadata = TrustedMaintainerMetadataCommon &
  (
    | { session_id: string; job_id?: string }
    | { session_id?: string; job_id: string }
  );

export type AutomatedMaintainerResult =
  | {
      status: "success";
      outcome: "no_change" | "rewrite";
      flaggedPath: null;
    }
  | {
      status: "flagged";
      outcome: "needs_input" | "stale";
      flaggedPath: string;
    }
  | {
      status: "locked";
      outcome: MaintainerOutput["outcome"];
      flaggedPath: null;
    };

interface PreparedRewrite {
  rewrite: MaintainerRewrite;
  targetPath: string;
  historyPath: string;
  dimensionPath: string;
  before: string | null; // null = target no longer exists
  mode: number;
}

/** A prepared rewrite that has passed the stale filter: its target exists. */
type ReadyRewrite = PreparedRewrite & { before: string };

const LOCK_DIRECTORY = ".automated-maintainer.lock";
const LOCK_LEASE_MS = 600_000; // 2x synthesize.ts TIMEOUT_MS (300s)

interface LockOwner {
  token: string;
  pid: number;
  acquired_at: string;
}

interface WorkspaceLock {
  path: string;
  ownerPath: string;
  token: string;
}

class StaleMaintainerSnapshotError extends Error {
  constructor(readonly rewrites: MaintainerRewrite[]) {
    super("Automated maintainer target changed during apply");
    this.name = "StaleMaintainerSnapshotError";
  }
}

/**
 * Apply an already validated maintainer result. Model-provided metadata on
 * `output` is intentionally ignored; all attribution comes from `metadata`.
 */
export function applyAutomatedMaintainerOutput(
  output: MaintainerOutput,
  metadata: TrustedMaintainerMetadata,
  workspace: string,
): AutomatedMaintainerResult {
  if (output.outcome === "no_change") {
    return { status: "success", outcome: "no_change", flaggedPath: null };
  }

  if (output.outcome === "needs_input") {
    const flaggedPath = stageFlaggedProposal(
      workspace,
      metadata,
      "needs_input",
      output.needs_input_reason,
      [],
    );
    return { status: "flagged", outcome: "needs_input", flaggedPath };
  }

  const lock = acquireWorkspaceLock(workspace);
  if (!lock) {
    return { status: "locked", outcome: "rewrite", flaggedPath: null };
  }

  try {
    const prepared = output.rewrites.map((rewrite) =>
      prepareRewrite(workspace, rewrite)
    );
    const stale = prepared.filter(
      ({ before, rewrite }) => before === null || sha256(before) !== rewrite.base_sha256
    );
    if (stale.length > 0) {
      const reason = [
        "The maintainer snapshot is stale; no context files were changed.",
        ...stale.map(({ before, rewrite }) =>
          before === null
            ? `${rewrite.file}: the target file no longer exists.`
            : `${rewrite.file}: expected ${rewrite.base_sha256}, found a different current hash.`,
        ),
      ].join("\n");
      const flaggedPath = stageFlaggedProposal(
        workspace,
        metadata,
        "stale",
        reason,
        output.rewrites,
      );
      return { status: "flagged", outcome: "stale", flaggedPath };
    }

    assertReady(prepared);
    try {
      applyPreparedRewrites(prepared, metadata, workspace);
    } catch (error) {
      if (!(error instanceof StaleMaintainerSnapshotError)) throw error;
      const flaggedPath = stageFlaggedProposal(
        workspace,
        metadata,
        "stale",
        [
          "The maintainer snapshot became stale during apply; no context files were changed.",
          ...error.rewrites.map(
            (rewrite) => `${rewrite.file}: the current hash no longer matches ${rewrite.base_sha256}.`,
          ),
        ].join("\n"),
        output.rewrites,
      );
      return { status: "flagged", outcome: "stale", flaggedPath };
    }
    return { status: "success", outcome: "rewrite", flaggedPath: null };
  } finally {
    releaseWorkspaceLock(lock);
  }
}

/** After the stale filter above, every entry's target existed and matched. */
function assertReady(items: PreparedRewrite[]): asserts items is ReadyRewrite[] {
  for (const item of items) {
    if (item.before === null) {
      throw new Error(`unreachable: missing rewrite target survived stale filter: ${item.rewrite.file}`);
    }
  }
}

function prepareRewrite(workspace: string, rewrite: MaintainerRewrite): PreparedRewrite {
  // 1. shape (duplicated by the validator on purpose — one line, different caller)
  if (!/^context\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/index\.md$/.test(rewrite.file)) {
    throw new Error(`Unsafe automated maintainer target: ${rewrite.file}`);
  }

  const workspaceReal = realpathSync(workspace);
  const targetPath = join(workspaceReal, ...rewrite.file.split("/"));
  const historyPath = rewrite.file.slice("context/".length);

  if (!existsSync(targetPath)) {
    return {
      rewrite,
      targetPath,
      historyPath,
      dimensionPath: dirname(targetPath),
      before: null,
      mode: 0o600,
    };
  }

  // 2. resolves to a regular file inside the workspace
  const targetReal = realpathSync(targetPath);
  requireContained(workspaceReal, targetReal, rewrite.file);
  if (!statSync(targetReal).isFile()) {
    throw new Error(`Automated maintainer target must be a regular file: ${rewrite.file}`);
  }

  return {
    rewrite,
    targetPath: targetReal,
    historyPath,
    dimensionPath: dirname(targetReal),
    before: readFileSync(targetReal, "utf8"),
    mode: statSync(targetReal).mode & 0o777,
  };
}

function applyPreparedRewrites(
  prepared: ReadyRewrite[],
  metadata: TrustedMaintainerMetadata,
  workspace: string,
): void {
  const replaced: ReadyRewrite[] = [];
  const logPaths: string[] = [];
  let db: Database | null = null;
  let transactionOpen = false;

  try {
    db = openHistoryDb(workspace);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    for (const item of prepared) {
      if (sha256(readFileSync(item.targetPath)) !== item.rewrite.base_sha256) {
        throw new StaleMaintainerSnapshotError([item.rewrite]);
      }
      atomicReplace(item.targetPath, item.rewrite.content, item.mode);
      replaced.push(item);
    }

    for (const item of prepared) {
      logPaths.push(writeTrustedLog(item, metadata));
    }

    for (const item of prepared) {
      insertAutomatedRewriteSnapshot(db, {
        sourceEventId: sourceEventId(metadata),
        filePath: item.historyPath,
        beforeContent: item.before,
        afterContent: item.rewrite.content,
        source: metadata.input_source,
        summary: item.rewrite.summary,
        createdAt: metadata.timestamp,
      });
      insertFileVersion(db, {
        filePath: item.historyPath,
        content: item.rewrite.content,
        createdAt: metadata.timestamp,
        source: "automated-maintainer",
        author: metadata.synthesized_by,
        sessionId: sourceEventId(metadata),
        publishedAt: null,
        changesEntryId: null,
      });
    }

    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    let restoreFailed = false;
    if (transactionOpen && db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        restoreFailed = true;
      }
    }
    for (const path of logPaths.reverse()) {
      try {
        unlinkSync(path);
      } catch {
        restoreFailed = true;
      }
    }
    for (const item of replaced.reverse()) {
      try {
        atomicReplace(item.targetPath, item.before, item.mode);
      } catch {
        restoreFailed = true;
      }
    }
    if (restoreFailed) {
      throw new Error(`Automated maintainer rollback incomplete after ${errorText(error)}`);
    }
    throw error;
  } finally {
    db?.close();
  }
}

function writeTrustedLog(
  item: ReadyRewrite,
  metadata: TrustedMaintainerMetadata,
): string {
  const logDirectory = join(item.dimensionPath, "log");
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });

  const filename = `${filenamePart(metadata.timestamp)}_${filenamePart(sourceEventId(metadata))}_${randomUUID()}.md`;
  const path = join(logDirectory, filename);
  const content = [
    "---",
    `source: ${yamlScalar(metadata.input_source)}`,
    `synthesized_by: ${yamlScalar(metadata.synthesized_by)}`,
    `session_id: ${yamlScalar(metadata.session_id ?? "")}`,
    ...(metadata.job_id ? [`job_id: ${yamlScalar(metadata.job_id)}`] : []),
    `timestamp: ${yamlScalar(metadata.timestamp)}`,
    `profile: ${yamlScalar(metadata.profile)}`,
    `summary: ${yamlScalar(item.rewrite.summary)}`,
    `before_sha256: ${yamlScalar(item.rewrite.base_sha256)}`,
    `after_sha256: ${yamlScalar(sha256(item.rewrite.content))}`,
    "trusted_automated_maintainer: true",
    "---",
    "",
    "# Automated maintainer update",
    "",
    item.rewrite.summary,
    ...(item.rewrite.removals?.length
      ? [
          "",
          "## Removed claims",
          "",
          ...item.rewrite.removals.map(
            (removal) => `- ${removal.claim} — ${removal.reason}`,
          ),
        ]
      : []),
    "",
  ].join("\n");

  writeNewFileDurably(path, content);
  return path;
}

function stageFlaggedProposal(
  workspace: string,
  metadata: TrustedMaintainerMetadata,
  kind: "needs_input" | "stale",
  reason: string,
  rewrites: MaintainerRewrite[],
): string {
  const workspaceReal = realpathSync(workspace);
  const proposalsDirectory = ensureSafeChildDirectory(workspaceReal, "proposals");
  const flaggedDirectory = ensureSafeChildDirectory(proposalsDirectory, "flagged");
  const path = join(
    flaggedDirectory,
    `${filenamePart(metadata.timestamp)}_${filenamePart(sourceEventId(metadata))}_${kind}_${randomUUID()}.md`,
  );
  const content = [
    "---",
    "action: review",
    `source: ${yamlScalar(metadata.input_source)}`,
    `synthesized_by: ${yamlScalar(metadata.synthesized_by)}`,
    `session_id: ${yamlScalar(metadata.session_id ?? "")}`,
    ...(metadata.job_id ? [`job_id: ${yamlScalar(metadata.job_id)}`] : []),
    `timestamp: ${yamlScalar(metadata.timestamp)}`,
    `profile: ${yamlScalar(metadata.profile)}`,
    "outcome: needs_input",
    `needs_input_reason: ${yamlScalar(reason)}`,
    `flagged_reason: ${yamlScalar(kind)}`,
    `summary: ${yamlScalar(kind === "stale" ? "Stale automated maintainer rewrite" : "Automated maintainer needs input")}`,
    "---",
    "",
    "# ⚠️ HUMAN REVIEW REQUIRED",
    "",
    "No context file was changed.",
    "",
    "## Reason",
    "",
    reason,
    ...(rewrites.length
      ? [
          "",
          "## Proposed rewrites",
          "",
          ...rewrites.flatMap((rewrite) => [
            `### ${rewrite.file}`,
            "",
            rewrite.summary,
            "",
            "```markdown",
            rewrite.content,
            "```",
            "",
          ]),
        ]
      : []),
  ].join("\n");
  writeNewFileDurably(path, content);
  return path;
}

function acquireWorkspaceLock(workspace: string): WorkspaceLock | null {
  const workspaceReal = realpathSync(workspace);
  const path = join(workspaceReal, LOCK_DIRECTORY);
  const ownerPath = join(path, "owner");

  for (const attempt of [0, 1]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 1) return null; // someone re-acquired it; give up
      if (!stealIfAbandoned(ownerPath)) return null;
      continue;
    }
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    try {
      writeNewFileDurably(ownerPath, JSON.stringify(owner));
      return { path, ownerPath, token: owner.token };
    } catch (error) {
      try {
        rmdirSync(path);
      } catch {
        // Preserve the acquisition failure.
      }
      throw error;
    }
  }
  return null;
}

/** True when the existing owner is dead or its lease expired and we removed it. */
function stealIfAbandoned(ownerPath: string): boolean {
  let owner: LockOwner | null = null;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
  } catch {
    owner = null; // missing/partial/legacy bare-token file — treat as abandoned
  }
  if (owner && typeof owner.pid === "number" && isPidAlive(owner.pid)) {
    const age = Date.now() - Date.parse(owner.acquired_at ?? "");
    if (!Number.isNaN(age) && age < LOCK_LEASE_MS) return false; // live and fresh
  }
  try {
    unlinkSync(ownerPath);
  } catch {}
  try {
    rmdirSync(dirname(ownerPath));
  } catch {
    return false;
  }
  return true;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseWorkspaceLock(lock: WorkspaceLock): void {
  try {
    const stat = lstatSync(lock.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const owner = JSON.parse(readFileSync(lock.ownerPath, "utf8")) as LockOwner;
    if (owner.token !== lock.token) return;
    unlinkSync(lock.ownerPath);
    rmdirSync(lock.path);
  } catch {
    // A missing/replaced lock must never cause deletion of another owner's lock.
  }
}

function atomicReplace(path: string, content: string, mode: number): void {
  const temporary = join(dirname(path), `.${randomUUID()}.automated-maintainer.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    writeAll(fd, content);
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function writeNewFileDurably(path: string, content: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeAll(fd, content);
    fdatasyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeAll(fd: number, content: string): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function ensureSafeChildDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function requireContained(parent: string, child: string, label: string): void {
  const rel = relative(parent, child);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return;
  }
  throw new Error(`Path escapes workspace: ${label}`);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function filenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 80) || "unknown";
}

function sourceEventId(metadata: TrustedMaintainerMetadata): string {
  if (metadata.session_id !== undefined) return metadata.session_id;
  return metadata.job_id!;
}
