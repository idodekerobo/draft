// desktop/src/main/sync/loadDiff.ts — team context sync engine
//
// Three exported functions:
//   readLocalDiff   — reads CHANGES.jsonl already in the workspace (what the hook applied)
//   fetchRemoteDiff — shallow-clones the team repo, reads delta from tmpDir (for manual pull + HITL)
//   applyFromTmpDir — copies context + CHANGES.jsonl from tmpDir → workspace, updates cursor

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { getWorkspacePath, getActiveProfile, readLocalConfig, writeLocalConfig, readCollaboration } from "draft-core/config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiffEntry {
  dimension: string;
  action: string;
  summary: string;
}

export interface LocalDiffResult {
  entries: DiffEntry[];
  cursorLine: number;
  lastLoaded: string | null;
}

export interface RemoteDiffResult {
  entries: DiffEntry[];
  cursorLine: number;
  tmpDir: string;
  collabConfigured: boolean;
}

// ── CHANGES.jsonl parsing ─────────────────────────────────────────────────────

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

function parseChangesJsonl(content: string): ChangesLine[] {
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

function toDiffEntry(line: ChangesLine): DiffEntry {
  // Derive dimension from explicit field or first file path
  let dimension = line.dimension ?? "";
  if (!dimension && Array.isArray(line.files) && line.files.length > 0) {
    // "context/product/index.md" → "product"
    const parts = line.files[0].split("/");
    dimension = parts.length >= 2 ? parts[1] : parts[0];
  }

  // Human-readable action label
  let action = "updated";
  if (line.type === "daemon-synthesis") action = "synthesized";
  else if (line.type === "manual-publish") action = "published";

  const summary = line.summary ?? (line.type === "daemon-synthesis"
    ? `Context updated from ${line.source ?? "session"}`
    : "Context updated");

  return { dimension, action, summary };
}

// ── readLocalDiff ─────────────────────────────────────────────────────────────

/**
 * Reads CHANGES.jsonl from the workspace (copied there by load-team.sh).
 * Returns entries since lastLoadCursor — what the hook applied that the
 * user hasn't seen yet.
 */
export function readLocalDiff(): LocalDiffResult {
  const workspace = getWorkspacePath(getActiveProfile());
  const changesPath = join(workspace, "CHANGES.jsonl");
  const configResult = readLocalConfig(workspace);
  const config = configResult.ok ? configResult.config : {};

  const lastLoaded = config.last_loaded ?? null;
  const lastCursor = config.lastLoadCursor ?? 0;

  if (!existsSync(changesPath)) {
    return { entries: [], cursorLine: lastCursor, lastLoaded };
  }

  let content: string;
  try {
    content = readFileSync(changesPath, "utf8");
  } catch {
    return { entries: [], cursorLine: lastCursor, lastLoaded };
  }

  const all = parseChangesJsonl(content);
  const totalLines = all.length;

  // Entries after the cursor = what arrived since last load
  const newLines = all.slice(lastCursor);
  const entries = newLines.map(toDiffEntry);

  return { entries, cursorLine: totalLines, lastLoaded };
}

// ── fetchRemoteDiff ───────────────────────────────────────────────────────────

/**
 * Shallow-clones the team repo to a temp dir, reads CHANGES.jsonl delta.
 * Returns entries + the tmpDir path (caller owns cleanup via applyFromTmpDir or manual rmSync).
 * If collab is not configured, returns collabConfigured: false with empty entries.
 */
export async function fetchRemoteDiff(): Promise<RemoteDiffResult> {
  const workspace = getWorkspacePath(getActiveProfile());
  const collabResult = readCollaboration(workspace);

  if (!collabResult.ok || !collabResult.collab.team_repo_url) {
    return { entries: [], cursorLine: 0, tmpDir: "", collabConfigured: false };
  }

  const { team_repo_url: repoUrl, team_repo_subdir: subdir = "root" } = collabResult.collab;

  const configResult = readLocalConfig(workspace);
  const lastCursor = configResult.ok ? (configResult.config.lastLoadCursor ?? 0) : 0;

  // Create temp dir
  const tmpDir = await makeTmpDir();

  try {
    // Shallow clone
    const cloneResult = await runCommand(["git", "clone", "--depth", "1", repoUrl, tmpDir]);
    if (cloneResult.exitCode !== 0) {
      safeRm(tmpDir);
      return { entries: [], cursorLine: 0, tmpDir: "", collabConfigured: true };
    }

    // Resolve source path based on team_repo_subdir
    const sourcePath = subdir === "root" ? tmpDir : join(tmpDir, subdir);
    const changesPath = join(sourcePath, "CHANGES.jsonl");

    if (!existsSync(changesPath)) {
      // No CHANGES.jsonl yet — collab is configured but no history
      return { entries: [], cursorLine: 0, tmpDir, collabConfigured: true };
    }

    let content: string;
    try {
      content = readFileSync(changesPath, "utf8");
    } catch {
      safeRm(tmpDir);
      return { entries: [], cursorLine: 0, tmpDir: "", collabConfigured: true };
    }

    const all = parseChangesJsonl(content);
    const totalLines = all.length;
    const newLines = all.slice(lastCursor);
    const entries = newLines.map(toDiffEntry);

    return { entries, cursorLine: totalLines, tmpDir, collabConfigured: true };
  } catch {
    safeRm(tmpDir);
    return { entries: [], cursorLine: 0, tmpDir: "", collabConfigured: true };
  }
}

// ── applyFromTmpDir ───────────────────────────────────────────────────────────

/**
 * Copies context/ + CHANGES.jsonl from tmpDir into the workspace.
 * Updates lastLoadCursor and last_loaded in local.json.
 * Deletes tmpDir when done.
 */
export function applyFromTmpDir(tmpDir: string, cursorLine: number): { ok: boolean; error?: string } {
  const workspace = getWorkspacePath(getActiveProfile());
  const collabResult = readCollaboration(workspace);

  if (!collabResult.ok) {
    safeRm(tmpDir);
    return { ok: false, error: "Collaboration not configured." };
  }

  const subdir = collabResult.collab.team_repo_subdir ?? "root";
  const sourcePath = subdir === "root" ? tmpDir : join(tmpDir, subdir);

  if (!existsSync(join(sourcePath, "context"))) {
    safeRm(tmpDir);
    return { ok: false, error: "No context/ found in team repo." };
  }

  try {
    // Copy context/
    mkdirSync(join(workspace, "context"), { recursive: true });
    cpSync(join(sourcePath, "context"), join(workspace, "context"), { recursive: true });

    // Copy CHANGES.jsonl if present
    const srcChanges = join(sourcePath, "CHANGES.jsonl");
    if (existsSync(srcChanges)) {
      writeFileSync(join(workspace, "CHANGES.jsonl"), readFileSync(srcChanges));
    }

    // Update cursor + last_loaded
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeLocalConfig(workspace, {
      lastLoadCursor: cursorLine,
      last_loaded: now,
    });
  } catch (err) {
    safeRm(tmpDir);
    return { ok: false, error: err instanceof Error ? err.message : "Apply failed." };
  }

  safeRm(tmpDir);
  return { ok: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  const base = `/tmp/draft-load-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(base, { recursive: true });
  return base;
}

function safeRm(dir: string) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

interface RunResult { exitCode: number; stderr: string }

function runCommand(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    proc.exited.then(async (code) => {
      const stderr = proc.stderr
        ? await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
        : "";
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}
