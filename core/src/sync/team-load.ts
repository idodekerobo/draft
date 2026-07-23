// core/src/sync/team-load.ts — shared "get team content" lifecycle
//
// Used by: draft-cli (cli/src/commands/sync.ts's runLoad, invoked on every
// Claude Code SessionStart via background/load-team.sh), draft-desktop
// (native GitHub OAuth join-team flow; Phase 2 will also repoint the
// existing manual "pull latest" here).
//
// Owns the full stage -> promote lifecycle: pre-flight guards (local/remote
// asset validation, dirty-baseline, unpublished-changes), transport (git
// clone or GitHub API tarball), archive validation, atomic
// uninstall/mirror/install with rollback, and asset-state/history
// bookkeeping. Callers never touch the filesystem lifecycle directly.

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { gunzipSync } from "zlib";
import { extract as tarExtract } from "tar-stream";
import { tmpdir, homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import {
  getActiveProfile,
  getWorkspacePath,
  readCollaboration,
  readLocalConfig,
  readSecrets,
  writeLocalConfig,
} from "../config";
import {
  cloneTeamRepo,
  mirrorDirectory,
  mirrorFile,
  walkMarkdownFiles,
  listUnpublishedContextPaths,
  hashAssets,
  equalHashes,
  assetsAreNonEmpty,
  assetState,
  writeAssetState,
} from "./publish";
import {
  installProfileAssets,
  uninstallProfileAssets,
  validateProfileAssets,
  withProfileSwitchLock,
  type MissingMcpSecrets,
  type TeamAssetConflict,
} from "./team-assets";
import { openHistoryDb, insertFileVersion } from "../db/history";

// ── logging ─────────────────────────────────────────────────────────────────
//
// Mirrors publish.ts's exact log() pattern — every attempt is appended here
// so users can self-diagnose. Never logs tokens or full URLs.

const LOG_FILE = join(homedir(), ".draft", "logs", "team-load.log");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [team-load] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

// ── DiffEntry / CHANGES.jsonl parsing ───────────────────────────────────────

export interface DiffEntry {
  dimension: string;
  action: string;
  summary: string;
}

interface ChangesLine {
  id?: string;
  ts?: string;
  type?: "manual-publish" | "daemon-synthesis" | string;
  dimension?: string;
  files?: string[];
  summary?: string;
  source?: string;
  session_id?: string;
}

export function parseChangesJsonl(content: string): ChangesLine[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as ChangesLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is ChangesLine => x !== null);
}

export function toDiffEntry(line: ChangesLine): DiffEntry {
  let dimension = line.dimension ?? "";
  if (!dimension && Array.isArray(line.files) && line.files.length > 0) {
    const parts = line.files[0]!.split("/");
    dimension = parts.length >= 2 ? parts[1]! : parts[0]!;
  }

  let action = "updated";
  if (line.type === "daemon-synthesis") action = "synthesized";
  else if (line.type === "manual-publish") action = "published";

  const summary = line.summary ?? (line.type === "daemon-synthesis"
    ? `Context updated from ${line.source ?? "session"}`
    : "Context updated");

  return { dimension, action, summary };
}

// ── GitHub repo URL parsing ──────────────────────────────────────────────────

export function parseGitHubRepoUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^([^/\s]+)\/([^/\s]+)$/, // "owner/repo" shorthand
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

// ── verifyRepoAccess ──────────────────────────────────────────────────────────

export async function verifyRepoAccess(
  token: string,
  owner: string,
  repo: string,
): Promise<
  | { ok: true; defaultBranch: string }
  | { ok: false; reason: "no_access" | "network" | "rate_limited" | "unknown"; status?: number }
> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    log(`verify-access: network error — owner=${owner} repo=${repo} — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "network" };
  }
  if (res.status === 401 || res.status === 404) {
    // 404 is GitHub's deliberate choice for "no access" on this endpoint (never
    // distinguishes "doesn't exist" from "you can't see it") — logging the raw
    // status is the only way to later tell a scope/account problem from a typo.
    log(`verify-access: no_access — owner=${owner} repo=${repo} status=${res.status}`);
    return { ok: false, reason: "no_access", status: res.status };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    log(`verify-access: rate_limited — owner=${owner} repo=${repo} status=${res.status}`);
    return { ok: false, reason: "rate_limited", status: res.status };
  }
  if (!res.ok) {
    log(`verify-access: unknown — owner=${owner} repo=${repo} status=${res.status}`);
    return { ok: false, reason: "unknown", status: res.status };
  }
  let body: { default_branch?: string };
  try {
    body = (await res.json()) as { default_branch?: string };
  } catch (err) {
    log(`verify-access: unknown — owner=${owner} repo=${repo} status=${res.status} — malformed response body: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "unknown", status: res.status };
  }
  if (!body.default_branch) {
    log(`verify-access: unknown — owner=${owner} repo=${repo} status=${res.status} — response had no default_branch`);
    return { ok: false, reason: "unknown", status: res.status };
  }
  log(`verify-access: ok — owner=${owner} repo=${repo} defaultBranch=${body.default_branch}`);
  return { ok: true, defaultBranch: body.default_branch };
}

// ── tarball download (github-api transport) ───────────────────────────────────

const TARBALL_MAX_BYTES = 50 * 1024 * 1024;
const ARCHIVE_MAX_FILES = 5_000;
const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

type DownloadError = "network" | "token_revoked" | "no_access" | "rate_limited" | "archive_too_large" | "archive_invalid";

async function downloadTarball(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: DownloadError }> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "follow",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (res.status === 401) return { ok: false, error: "token_revoked" };
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") return { ok: false, error: "rate_limited" };
  if (res.status === 404 || res.status === 403) return { ok: false, error: "no_access" };
  if (!res.ok || !res.body) return { ok: false, error: "archive_invalid" };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Byte cap enforced while streaming — abort the connection the moment the
  // cap is crossed, never finish buffering an oversized response first.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TARBALL_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* non-fatal */ }
      return { ok: false, error: "archive_too_large" };
    }
    chunks.push(value);
  }
  return { ok: true, buffer: Buffer.concat(chunks) };
}

// ── archive validation + extraction ───────────────────────────────────────────
//
// Two passes over the decompressed tar, both via tar-stream so entries are
// parsed programmatically (type/path/size) rather than regex-parsed system
// `tar -tvf` text. Pass 1 validates every entry and rejects the whole
// archive — nothing extracted — before pass 2 ever touches disk.

type ArchiveRejection = "unsafe_entry" | "path_traversal" | "too_many_files" | "too_large";

/**
 * Symlinks are skipped individually rather than causing a whole-archive
 * rejection: real published repos legitimately contain them (e.g.
 * gstack-managed skill files mirrored via cpSync, which preserves symlinks
 * rather than dereferencing them), and extractArchive below never writes a
 * symlink to disk in the first place (it only handles "file"/"directory"
 * entries) — so there's no path-traversal or arbitrary-write risk from
 * letting one through. Hardlinks and device/fifo entries have no legitimate
 * reason to appear in a git-generated tarball at all, so those still reject
 * the whole archive as a signal of a malformed/tampered download.
 */
function validateArchive(tarBuf: Buffer): Promise<{ ok: true; skippedSymlinks: number } | { ok: false; reason: ArchiveRejection }> {
  return new Promise((resolvePromise) => {
    const ex = tarExtract();
    let fileCount = 0;
    let totalSize = 0;
    let skippedSymlinks = 0;
    let failed: ArchiveRejection | null = null;

    ex.on("entry", (header, stream, next) => {
      if (!failed) {
        if (header.name.startsWith("/") || header.name.split("/").includes("..")) {
          failed = "path_traversal";
        } else if (header.type === "link" || header.type === "character-device"
          || header.type === "block-device" || header.type === "fifo") {
          failed = "unsafe_entry";
        } else if (header.type === "symlink") {
          skippedSymlinks++;
        } else if (header.type === "file") {
          fileCount++;
          totalSize += header.size ?? 0;
          if (fileCount > ARCHIVE_MAX_FILES) failed = "too_many_files";
          else if (totalSize > ARCHIVE_MAX_UNCOMPRESSED_BYTES) failed = "too_large";
        }
      }
      stream.resume(); // drain and discard — pass 1 never writes to disk
      stream.on("end", () => next());
      stream.on("error", () => next());
    });
    ex.on("finish", () => resolvePromise(failed ? { ok: false, reason: failed } : { ok: true, skippedSymlinks }));
    ex.on("error", () => resolvePromise({ ok: false, reason: "unsafe_entry" }));
    ex.end(tarBuf);
  });
}

function extractArchive(tarBuf: Buffer, destDir: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ex = tarExtract();
    ex.on("entry", (header, stream, next) => {
      const target = join(destDir, header.name);
      if (header.type === "directory") {
        mkdirSync(target, { recursive: true });
        stream.resume();
        next();
        return;
      }
      if (header.type !== "file") {
        stream.resume();
        next();
        return;
      }
      const bodyChunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      stream.on("end", () => {
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.concat(bodyChunks));
          next();
        } catch (err) {
          next(err as Error);
        }
      });
      stream.on("error", (err) => next(err));
    });
    ex.on("finish", () => resolvePromise());
    ex.on("error", (err) => rejectPromise(err));
    ex.end(tarBuf);
  });
}

/** GitHub's tarball API always wraps content in one generated top-level dir (owner-repo-<sha>/). */
function findSingleTopLevelDir(destDir: string): string | null {
  const entries = readdirSync(destDir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null;
  return entries[0]!.name;
}

// ── in-memory staged-content tracking ─────────────────────────────────────────
//
// The renderer only ever holds an operationId, never a filesystem path.

interface StagedInternal {
  operationId: string;
  workspace: string;
  profile: string;
  root: string;
  cleanupPaths: string[];
  entries: DiffEntry[];
  cursorLine: number;
  createdAt: number;
}

const STAGE_TTL_MS = 15 * 60_000;
const stagedMap = new Map<string, StagedInternal>();

function gcStaged(): void {
  const now = Date.now();
  for (const [id, staged] of stagedMap) {
    if (now - staged.createdAt > STAGE_TTL_MS) {
      for (const path of staged.cleanupPaths) rmSync(path, { recursive: true, force: true });
      stagedMap.delete(id);
    }
  }
}

// ── stageTeamContent ───────────────────────────────────────────────────────────

export interface StageOptions {
  workspace: string;
  profile: string;
  discardTeamAssets?: boolean;
}

export interface StagedTeamContent {
  operationId: string;
  workspace: string;
  profile: string;
  entries: DiffEntry[];
  cursorLine: number;
}

export type StageErrorCode =
  | "no_token" | "no_access" | "token_revoked" | "network" | "rate_limited"
  | "archive_invalid" | "archive_too_large"
  | "unpublished_local_changes" | "unpublished_team_assets"
  | "local_asset_validation_failed" | "remote_asset_validation_failed"
  | "clone_failed";

export type StageResult =
  | { ok: true; staged: StagedTeamContent }
  | { ok: false; error: StageErrorCode };

export async function stageTeamContent(opts: StageOptions): Promise<StageResult> {
  gcStaged();
  const { workspace, profile, discardTeamAssets } = opts;

  const localValidation = validateProfileAssets(profile, { workspacePath: workspace });
  if (!localValidation.ok) {
    log(`stage: local_asset_validation_failed profile=${profile}`);
    return { ok: false, error: "local_asset_validation_failed" };
  }

  if (!discardTeamAssets) {
    const currentHashes = hashAssets(workspace);
    const baseline = assetState(workspace).baseline;
    if ((!baseline && assetsAreNonEmpty(workspace)) || (baseline && !equalHashes(currentHashes, baseline))) {
      log(`stage: unpublished_team_assets profile=${profile}`);
      return { ok: false, error: "unpublished_team_assets" };
    }
    if (listUnpublishedContextPaths(workspace).length > 0) {
      log(`stage: unpublished_local_changes profile=${profile}`);
      return { ok: false, error: "unpublished_local_changes" };
    }
  }

  const localConfigResult = readLocalConfig(workspace);
  const syncMethod = localConfigResult.ok ? (localConfigResult.config.sync_method ?? "git") : "git";
  const cleanupPaths: string[] = [];
  let root: string;

  if (syncMethod === "github-api") {
    const secretsResult = readSecrets(workspace);
    const token = secretsResult.ok ? secretsResult.secrets.github_oauth_token : undefined;
    if (!token) {
      log(`stage: no_token profile=${profile}`);
      return { ok: false, error: "no_token" };
    }
    const collab = readCollaboration(workspace);
    if (!collab.ok || !collab.collab.team_repo_url) {
      log(`stage: no_access (no team_repo_url) profile=${profile}`);
      return { ok: false, error: "no_access" };
    }
    const parsed = parseGitHubRepoUrl(collab.collab.team_repo_url);
    if (!parsed) {
      log(`stage: no_access (unparsable team_repo_url) profile=${profile}`);
      return { ok: false, error: "no_access" };
    }
    const branch = localConfigResult.ok ? localConfigResult.config.default_branch : undefined;
    if (!branch) {
      log(`stage: no_access (no default_branch) profile=${profile}`);
      return { ok: false, error: "no_access" };
    }

    const download = await downloadTarball(token, parsed.owner, parsed.repo, branch);
    if (!download.ok) {
      log(`stage: ${download.error} profile=${profile} transport=github-api`);
      return { ok: false, error: download.error };
    }

    let tarBuf: Buffer;
    try {
      tarBuf = gunzipSync(download.buffer);
    } catch {
      log(`stage: archive_invalid (gunzip failed) profile=${profile}`);
      return { ok: false, error: "archive_invalid" };
    }

    const archiveValidation = await validateArchive(tarBuf);
    if (!archiveValidation.ok) {
      log(`stage: archive rejected — ${archiveValidation.reason} profile=${profile}`);
      const tooBig = archiveValidation.reason === "too_large" || archiveValidation.reason === "too_many_files";
      return { ok: false, error: tooBig ? "archive_too_large" : "archive_invalid" };
    }
    if (archiveValidation.skippedSymlinks > 0) {
      log(`stage: skipped ${archiveValidation.skippedSymlinks} symlink entr${archiveValidation.skippedSymlinks === 1 ? "y" : "ies"} in archive profile=${profile}`);
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "draft-team-api-"));
    cleanupPaths.push(tmpDir);
    try {
      await extractArchive(tarBuf, tmpDir);
    } catch {
      for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
      log(`stage: archive_invalid (extract failed) profile=${profile}`);
      return { ok: false, error: "archive_invalid" };
    }

    const topLevel = findSingleTopLevelDir(tmpDir);
    if (!topLevel) {
      for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
      log(`stage: archive_invalid (no single top-level dir) profile=${profile}`);
      return { ok: false, error: "archive_invalid" };
    }
    const effectiveRoot = join(tmpDir, topLevel);
    const subdir = collab.collab.team_repo_subdir;
    root = subdir && subdir !== "root" ? join(effectiveRoot, subdir) : effectiveRoot;
  } else {
    const cloned = await cloneTeamRepo(workspace);
    if ("error" in cloned) {
      log(`stage: clone_failed — ${cloned.error} profile=${profile}`);
      return { ok: false, error: "clone_failed" };
    }
    cleanupPaths.push(cloned.tmp);
    root = cloned.root;
  }

  // TEMPORARY (unblocks the join flow while the real fix — dereferencing
  // symlinks on publish, so workspace/skills/ always contains real content —
  // is still open, see plans/ for the tracked bug). A skill directory can
  // reach this point with no SKILL.md: the archive transport drops symlinks
  // entirely during extraction (never writes them), and the git-clone
  // transport can produce a symlink that's dangling on any machine other
  // than the one that published it. Either way, prune incomplete skill
  // directories before validation instead of failing the whole join over
  // content that was never real to begin with — the skill is just absent
  // for this teammate, not a reason to block everything else they're
  // joining. Does not touch validateProfileAssets itself, so its stricter
  // behavior for local/publish/install call sites is unaffected.
  const skillsRoot = join(root, "skills");
  let prunedSkills = 0;
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsRoot, entry.name);
      if (!existsSync(join(skillDir, "SKILL.md"))) {
        rmSync(skillDir, { recursive: true, force: true });
        prunedSkills++;
      }
    }
  }
  if (prunedSkills > 0) {
    log(`stage: pruned ${prunedSkills} incomplete skill dir${prunedSkills === 1 ? "" : "s"} (no SKILL.md) profile=${profile}`);
  }

  const remoteValidation = validateProfileAssets(profile, { workspacePath: root });
  if (!remoteValidation.ok) {
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    log(`stage: remote_asset_validation_failed profile=${profile}`);
    return { ok: false, error: "remote_asset_validation_failed" };
  }

  const lastCursor = localConfigResult.ok ? (localConfigResult.config.lastLoadCursor ?? 0) : 0;
  const changesPath = join(root, "CHANGES.jsonl");
  let entries: DiffEntry[] = [];
  let cursorLine = lastCursor;
  if (existsSync(changesPath)) {
    const all = parseChangesJsonl(readFileSync(changesPath, "utf8"));
    cursorLine = all.length;
    entries = all.slice(lastCursor).map(toDiffEntry);
  }

  const operationId = randomUUID();
  stagedMap.set(operationId, {
    operationId, workspace, profile, root, cleanupPaths, entries, cursorLine, createdAt: Date.now(),
  });
  log(`stage: ok profile=${profile} transport=${syncMethod} operationId=${operationId}`);
  return { ok: true, staged: { operationId, workspace, profile, entries, cursorLine } };
}

// ── promoteStagedTeamContent ────────────────────────────────────────────────────

export type MissingSecret = MissingMcpSecrets;
export type AssetConflict = TeamAssetConflict;

export type PromoteResult =
  | {
      ok: true;
      missingSecrets: MissingSecret[];
      conflicts: AssetConflict[];
      installedSkills: string[];
      installedMcps: string[];
      removedSkills: string[];
      removedMcps: string[];
    }
  | { ok: false; error: "workspace_changed" | "stage_not_found" | "apply_failed" };

const SNAPSHOT_ITEMS = [
  { rel: "context", kind: "dir" as const },
  { rel: "skills", kind: "dir" as const },
  { rel: "CHANGES.jsonl", kind: "file" as const },
  { rel: join("config", "mcp.json"), kind: "file" as const },
  { rel: join("config", "collaboration.json"), kind: "file" as const },
];

function recordHistoryRows(workspace: string, backupContextRoot: string): void {
  const newContextRoot = join(workspace, "context");
  const loadedAt = new Date().toISOString();
  const db = openHistoryDb(workspace);
  try {
    const relPaths = new Set([...walkMarkdownFiles(newContextRoot), ...walkMarkdownFiles(backupContextRoot)]);
    for (const relPath of relPaths) {
      const newPath = join(newContextRoot, relPath);
      const oldPath = join(backupContextRoot, relPath);
      const newContent = existsSync(newPath) ? readFileSync(newPath, "utf8") : null;
      const oldContent = existsSync(oldPath) ? readFileSync(oldPath, "utf8") : null;
      if (newContent !== null && newContent !== oldContent) {
        // Content just arrived from the team repo, so it IS the current
        // published state — mark it published at load time.
        insertFileVersion(db, {
          filePath: relPath,
          content: newContent,
          createdAt: loadedAt,
          source: "team-load",
          author: null,
          sessionId: null,
          publishedAt: loadedAt,
          changesEntryId: null,
        });
      }
    }
  } finally {
    db.close();
  }
}

/**
 * withProfileSwitchLock is a single non-blocking attempt (returns undefined
 * if another live process holds it). A concurrent profile switch completes
 * in milliseconds, so retry with a short backoff instead of failing outright
 * on the first miss — this is what makes promote correctly wait out a
 * contended lock rather than racing or bailing.
 */
async function withProfileSwitchLockRetrying<T>(fn: () => Promise<T>, timeoutMs = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await withProfileSwitchLock(fn);
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function promoteStagedTeamContent(operationId: string): Promise<PromoteResult> {
  gcStaged();
  const staged = stagedMap.get(operationId);
  if (!staged) {
    log(`promote: stage_not_found operationId=${operationId}`);
    return { ok: false, error: "stage_not_found" };
  }

  const activeWorkspace = getWorkspacePath(getActiveProfile());
  if (activeWorkspace !== staged.workspace) {
    log(`promote: workspace_changed operationId=${operationId}`);
    return { ok: false, error: "workspace_changed" };
  }

  const { workspace, profile, root, cleanupPaths } = staged;

  // Snapshot, exact bytes — record whether each item existed at all so
  // restore can delete, not just overwrite-with-stale-content.
  const backupDir = mkdtempSync(join(tmpdir(), "draft-load-backup-"));
  const existedBefore = new Map<string, boolean>();
  for (const item of SNAPSHOT_ITEMS) {
    const source = join(workspace, item.rel);
    const existed = existsSync(source);
    existedBefore.set(item.rel, existed);
    if (existed) {
      const dest = join(backupDir, item.rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest, { recursive: item.kind === "dir" });
    }
  }

  const restoreSnapshot = () => {
    for (const item of SNAPSHOT_ITEMS) {
      const dest = join(workspace, item.rel);
      const backupPath = join(backupDir, item.rel);
      if (existedBefore.get(item.rel)) {
        if (item.kind === "dir") mirrorDirectory(backupPath, dest);
        else mirrorFile(backupPath, dest);
      } else {
        rmSync(dest, { recursive: true, force: true });
      }
    }
  };

  const outcome = await withProfileSwitchLockRetrying<PromoteResult>(async () => {
    // The active profile may have changed while we were waiting for the lock.
    // Re-check under the same lock that protects uninstall/mirror/install so
    // no mutation can begin against a workspace that is no longer active.
    const lockedActiveWorkspace = getWorkspacePath(getActiveProfile());
    if (lockedActiveWorkspace !== workspace) {
      log(`promote: workspace_changed inside profile-switch lock operationId=${operationId}`);
      return { ok: false, error: "workspace_changed" };
    }

    try {
      const uninstallResult = await uninstallProfileAssets(profile);

      mirrorDirectory(join(root, "context"), join(workspace, "context"));
      mirrorDirectory(join(root, "skills"), join(workspace, "skills"));
      mirrorFile(join(root, "config", "mcp.json"), join(workspace, "config", "mcp.json"));
      mirrorFile(join(root, "config", "collaboration.json"), join(workspace, "config", "collaboration.json"));
      mirrorFile(join(root, "CHANGES.jsonl"), join(workspace, "CHANGES.jsonl"));

      const installResult = await installProfileAssets(profile);

      const hashes = hashAssets(workspace);
      writeAssetState(workspace, hashes, "load");
      writeLocalConfig(workspace, {
        last_loaded: new Date().toISOString(),
        lastLoadCursor: staged.cursorLine,
      });

      // History rows last, not before asset-state/local-config writes — a
      // later failure in those steps must never leave orphaned history rows
      // describing content that then gets rolled back.
      recordHistoryRows(workspace, join(backupDir, "context"));

      return {
        ok: true,
        missingSecrets: installResult.missingSecrets.map((m) => ({ name: m.name, requiredSecrets: m.requiredSecrets })),
        conflicts: [...uninstallResult.conflicts, ...installResult.conflicts],
        installedSkills: installResult.installedSkills,
        installedMcps: installResult.installedMcps,
        removedSkills: uninstallResult.removedSkills,
        removedMcps: uninstallResult.removedMcps,
      };
    } catch (err) {
      log(`promote: apply_failed — ${err instanceof Error ? err.message : String(err)} operationId=${operationId}`);
      restoreSnapshot();
      try {
        await installProfileAssets(profile);
      } catch (restoreErr) {
        log(`promote: restore install also failed — ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
      return { ok: false, error: "apply_failed" };
    }
  });

  rmSync(backupDir, { recursive: true, force: true });
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  stagedMap.delete(operationId);

  if (outcome === undefined) {
    log(`promote: apply_failed — profile-switch lock unavailable operationId=${operationId}`);
    return { ok: false, error: "apply_failed" };
  }

  log(`promote: ${outcome.ok ? "ok" : outcome.error} operationId=${operationId}`);
  return outcome;
}
