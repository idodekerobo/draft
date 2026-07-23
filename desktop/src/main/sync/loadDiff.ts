// desktop/src/main/sync/loadDiff.ts — local CHANGES.jsonl reader
//
// Remote staging and promotion live in draft-core/sync/team-load. This module
// only reads the already-promoted local changelog for desktop display.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getWorkspacePath, getActiveProfile, readLocalConfig } from "draft-core/config";
import {
  parseChangesJsonl,
  toDiffEntry,
  type DiffEntry,
} from "draft-core/sync/team-load";

export interface LocalDiffResult {
  entries: DiffEntry[];
  cursorLine: number;
  lastLoaded: string | null;
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
