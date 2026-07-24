// core/src/sync/publish.ts — transactional team-publish core
//
// Used by: draft-cli (cli/src/commands/sync.ts), draft-desktop (main process RPC)
//
// Pure git/gh subprocess orchestration — no LLM involved at runtime. Callers
// (CLI, desktop) are responsible for pre-flight checks (gh auth,
// validateProfileAssets) and formatting the result for their surface.

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { tmpdir, homedir } from "os";
import { dirname, join, relative, resolve } from "path";
import { capture as defaultCapture, type CaptureResult } from "../exec";
import { readCollaboration, readLocalConfig, writeLocalConfig } from "../config";
import {
  openHistoryDb,
  getLatestUnpublishedVersion,
  markPublished,
} from "../db/history";

// ── logging ─────────────────────────────────────────────────────────────────
//
// Every publish attempt (success or failure) is appended here so users can
// self-diagnose without re-running with a debugger attached. Mirrors the
// desktop-installer.log convention (desktop/src/main/installer.ts).

const LOG_FILE = join(homedir(), ".draft", "logs", "publish.log");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [publish] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

type CaptureFn = (
  cmd: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> }
) => Promise<CaptureResult>;

// ── asset hashing (skills/, config/mcp.json) ───────────────────────────────────

export interface AssetHashes {
  skills_hash: string;
  mcp_hash: string;
}

interface TeamAssetLocalState {
  baseline?: AssetHashes;
  last_remote?: AssetHashes;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function hashSkills(workspace: string): string {
  const root = join(workspace, "skills");
  const hash = createHash("sha256");
  if (!existsSync(root)) return `sha256:${hash.update("").digest("hex")}`;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store" || entry.name.startsWith(".draft-")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function hashMcp(workspace: string): string {
  const path = join(workspace, "config", "mcp.json");
  const value = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { version: 1, servers: [] };
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function hashAssets(workspace: string): AssetHashes {
  return { skills_hash: hashSkills(workspace), mcp_hash: hashMcp(workspace) };
}

export function equalHashes(a?: AssetHashes, b?: AssetHashes): boolean {
  return !!a && !!b && a.skills_hash === b.skills_hash && a.mcp_hash === b.mcp_hash;
}

export function assetsAreNonEmpty(workspace: string): boolean {
  const skills = join(workspace, "skills");
  if (existsSync(skills) && readdirSync(skills).some((name) => !name.startsWith("."))) return true;
  const mcp = join(workspace, "config", "mcp.json");
  if (!existsSync(mcp)) return false;
  try {
    return (JSON.parse(readFileSync(mcp, "utf8")).servers ?? []).length > 0;
  } catch {
    return true;
  }
}

export function assetState(workspace: string): TeamAssetLocalState {
  const local = readLocalConfig(workspace);
  if (!local.ok) return {};
  return ((local.config as typeof local.config & { team_assets?: TeamAssetLocalState }).team_assets ?? {});
}

export function writeAssetState(workspace: string, hashes: AssetHashes, kind: "load" | "publish"): void {
  const current = readLocalConfig(workspace);
  const prior = current.ok
    ? ((current.config as typeof current.config & { team_assets?: TeamAssetLocalState }).team_assets ?? {})
    : {};
  writeLocalConfig(workspace, {
    team_assets: {
      ...prior,
      baseline: hashes,
      ...(kind === "load" ? { last_remote: hashes } : {}),
    },
  });
}

// ── filesystem mirroring ────────────────────────────────────────────────────────

export function mirrorDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

export function mirrorFile(source: string, destination: string): void {
  rmSync(destination, { force: true });
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

/**
 * Returns null (safe) or a soft error message if relPath would escape the
 * workspace's context/ directory once resolved.
 */
function validateScopedPath(workspace: string, relPath: string): string | null {
  const contextRoot = resolve(join(workspace, "context"));
  const resolved = resolve(join(contextRoot, relPath));
  if (resolved !== contextRoot && !resolved.startsWith(contextRoot + "/")) {
    return `Path escapes context/: ${relPath}`;
  }
  return null;
}

function copyPublishedState(workspace: string, repoRoot: string, opts?: { paths?: string[] }): void {
  if (opts?.paths?.length) {
    for (const relPath of opts.paths) {
      mirrorFile(join(workspace, "context", relPath), join(repoRoot, "context", relPath));
    }
    return;
  }
  mirrorDirectory(join(workspace, "context"), join(repoRoot, "context"));
  mirrorDirectory(join(workspace, "skills"), join(repoRoot, "skills"));
  mirrorFile(join(workspace, "config", "mcp.json"), join(repoRoot, "config", "mcp.json"));
  mirrorFile(join(workspace, "config", "collaboration.json"), join(repoRoot, "config", "collaboration.json"));
}

export function walkMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) results.push(relative(root, path));
    }
  };
  walk(root);
  return results;
}

// ── unpublished-context discovery ───────────────────────────────────────────────

/**
 * Returns the actual relative paths (under context/) that have an
 * unpublished latest version in history.db — the same authoritative source
 * markPublished itself uses. Replaces the old mtime-over-log-files heuristic.
 */
export function listUnpublishedContextPaths(workspace: string): string[] {
  const db = openHistoryDb(workspace);
  try {
    const results: string[] = [];
    for (const relPath of walkMarkdownFiles(join(workspace, "context"))) {
      const version = getLatestUnpublishedVersion(db, relPath);
      if (version && !version.publishedAt) results.push(relPath);
    }
    return results;
  } finally {
    db.close();
  }
}

// ── team repo clone ──────────────────────────────────────────────────────────────

export async function cloneTeamRepo(
  workspace: string,
  capture: CaptureFn = defaultCapture
): Promise<{ tmp: string; root: string } | { error: string }> {
  const collab = readCollaboration(workspace);
  if (!collab.ok || collab.collab.mode !== "github" || !collab.collab.team_repo_url) {
    log("clone: not configured — no collaboration.json / team_repo_url for this workspace");
    return { error: "No team repo configured. Run /draft-setup-collab first." };
  }
  const tmp = mkdtempSync(join(tmpdir(), "draft-team-"));
  const cloned = await capture(["git", "clone", "--depth", "1", collab.collab.team_repo_url, tmp], { timeoutMs: 60_000 });
  if (cloned.exitCode !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    const error = cloned.stderr.trim() || cloned.stdout.trim() || "Failed to clone team repository.";
    log(`clone: failed — url=${collab.collab.team_repo_url} error=${error}`);
    return { error };
  }
  const root = collab.collab.team_repo_subdir && collab.collab.team_repo_subdir !== "root"
    ? join(tmp, collab.collab.team_repo_subdir)
    : tmp;
  return { tmp, root };
}

// ── publish transaction ──────────────────────────────────────────────────────────

export interface PublishTeamContextOpts {
  paths?: string[];
  capture?: CaptureFn;
}

export interface PublishTeamContextResult {
  ok: boolean;
  published: boolean;      // false = "nothing to publish" no-op
  scoped: boolean;
  files: string[];          // actual paths committed
  proposalsCleared: number; // always 0 for a scoped publish
}

export class PublishError extends Error {}

export async function publishTeamContext(
  workspace: string,
  profile: string,
  opts?: PublishTeamContextOpts
): Promise<PublishTeamContextResult> {
  const capture = opts?.capture ?? defaultCapture;
  const scoped = !!opts?.paths?.length;

  log(`start — profile=${profile} scoped=${scoped}${scoped ? ` paths=${JSON.stringify(opts!.paths)}` : ""}`);

  if (scoped) {
    for (const relPath of opts!.paths!) {
      const error = validateScopedPath(workspace, relPath);
      if (error) {
        log(`error — ${error}`);
        throw new PublishError(error);
      }
    }
  }

  const gh = await capture(["gh", "api", "user", "--jq", ".login"]);
  const author = gh.exitCode === 0 ? gh.stdout.trim() : undefined;
  if (gh.exitCode !== 0) log(`gh auth check failed (exit ${gh.exitCode}) — proceeding without an author`);

  const cloned = await cloneTeamRepo(workspace, capture);
  if ("error" in cloned) {
    log(`error — ${cloned.error}`);
    throw new PublishError(cloned.error);
  }

  try {
    mkdirSync(cloned.root, { recursive: true });
    copyPublishedState(workspace, cloned.root, scoped ? { paths: opts!.paths } : undefined);
    // A full publish's baseline must describe the exact asset snapshot staged
    // in the team repo, not a later view of the live workspace.
    const publishedAssetHashes = scoped ? undefined : hashAssets(cloned.root);

    const changesPath = join(cloned.root, "CHANGES.jsonl");
    const change = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: "team-publish",
      author,
      profile,
      files: scoped ? opts!.paths!.map((p) => `context/${p}`) : ["context/", "skills/", "config/mcp.json"],
    };
    writeFileSync(changesPath, (existsSync(changesPath) ? readFileSync(changesPath, "utf8").trimEnd() + "\n" : "") + JSON.stringify(change) + "\n");

    const subdirPrefix = relative(cloned.tmp, cloned.root);
    const prefixed = (relPath: string) => (subdirPrefix ? join(subdirPrefix, relPath) : relPath);

    const addTargets = scoped
      ? [...opts!.paths!.map((p) => prefixed(join("context", p))), prefixed("CHANGES.jsonl")]
      : ["-A"];
    const add = scoped
      ? await capture(["git", "-C", cloned.tmp, "add", "--", ...addTargets])
      : await capture(["git", "-C", cloned.tmp, "add", "-A"]);
    if (add.exitCode !== 0) {
      const error = add.stderr || "git add failed";
      log(`error — git add: ${error}`);
      throw new PublishError(error);
    }

    const status = await capture(["git", "-C", cloned.tmp, "status", "--porcelain"]);
    if (status.exitCode !== 0) {
      const error = status.stderr || "git status failed";
      log(`error — git status: ${error}`);
      throw new PublishError(error);
    }
    if (!status.stdout.trim()) {
      log("nothing to publish — working tree matches remote");
      return { ok: true, published: false, scoped, files: [], proposalsCleared: 0 };
    }

    const commit = await capture(["git", "-C", cloned.tmp, "commit", "-m", `draft publish: ${profile}`]);
    if (commit.exitCode !== 0) {
      const error = commit.stderr || commit.stdout || "git commit failed";
      log(`error — git commit: ${error}`);
      throw new PublishError(error);
    }
    const push = await capture(["git", "-C", cloned.tmp, "push"], { timeoutMs: 60_000 });
    if (push.exitCode !== 0) {
      const error = push.stderr || push.stdout || "git push failed";
      log(`error — git push: ${error}`);
      throw new PublishError(error);
    }

    const historyDb = openHistoryDb(workspace);
    try {
      const pathsToMark = scoped ? opts!.paths! : walkMarkdownFiles(join(workspace, "context"));
      for (const relPath of pathsToMark) {
        const version = getLatestUnpublishedVersion(historyDb, relPath);
        if (version && !version.publishedAt) {
          markPublished(historyDb, version.id, change.ts, change.id);
        }
      }
    } finally {
      historyDb.close();
    }

    let proposalsCleared = 0;
    if (!scoped) {
      const accepted = join(workspace, "accepted");
      if (existsSync(accepted)) {
        for (const name of readdirSync(accepted).filter((entry) => entry.endsWith(".md"))) {
          unlinkSync(join(accepted, name));
          proposalsCleared++;
        }
      }
    }

    writeLocalConfig(workspace, { last_published: new Date().toISOString() });
    if (publishedAssetHashes) {
      writeAssetState(workspace, publishedAssetHashes, "publish");
    }

    const files = scoped ? opts!.paths! : walkMarkdownFiles(join(workspace, "context"));
    log(`success — files=${files.length} proposalsCleared=${proposalsCleared}`);

    return {
      ok: true,
      published: true,
      scoped,
      files,
      proposalsCleared,
    };
  } catch (err) {
    if (!(err instanceof PublishError)) {
      log(`error — unexpected: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    rmSync(cloned.tmp, { recursive: true, force: true });
  }
}
