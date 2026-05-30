// core/src/proposals.ts — Proposal type and file operations
//
// Used by: draft-cli (commands/proposals.ts), draft-desktop (proposals UI)
// Interactive UI logic (keypress reader, rendering) stays in CLI — only data
// operations live here so the desktop can reuse them.

import { existsSync, readdirSync, renameSync, statSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Proposal {
  filename: string;
  path: string;
  mtime: number;
  source: string;
  createdAt: string;
  timestamp: string;
  dimension: string;
  action: string;
  synthesizedBy: string;
  summary: string;
  body: string;
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * List all .md proposals in the workspace proposals/ dir, sorted oldest-first.
 * Returns [] if the directory doesn't exist or is empty.
 */
export function listProposals(workspacePath: string): Proposal[] {
  const proposalsDir = join(workspacePath, "proposals");
  if (!existsSync(proposalsDir)) return [];

  const files = readdirSync(proposalsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      path: join(proposalsDir, f),
      mtime: statSync(join(proposalsDir, f)).mtimeMs,
    }))
    .sort((a, b) => a.mtime - b.mtime);

  return files.map((f) => parseProposal(f.name, f.path));
}

/**
 * Parse a single proposal file. Extracts YAML frontmatter fields used by both
 * the legacy CLI proposal format and the desktop T2 proposal inbox schema:
 *   dimension, action, source, synthesized_by, timestamp, created_at, summary
 * Body is everything after the closing --- of frontmatter.
 */
export function parseProposal(filename: string, filePath: string): Proposal {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    // unreadable file — return minimal shell
  }

  let source = "unknown";
  let createdAt = "";
  let timestamp = "";
  let dimension = "unknown";
  let action = "update";
  let synthesizedBy = "";
  let summary = filename;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = parseFrontmatter(fmMatch[1] ?? "");
    source = stringField(fm.source) || source;
    createdAt = stringField(fm.created_at) || stringField(fm.createdAt) || createdAt;
    timestamp = stringField(fm.timestamp) || createdAt;
    dimension = stringField(fm.dimension) || dimension;
    action = stringField(fm.action) || action;
    synthesizedBy = stringField(fm.synthesized_by) || stringField(fm.synthesizedBy) || synthesizedBy;
    summary = stringField(fm.summary) || summary;
  }

  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
  if (summary === filename && dimension !== "unknown") {
    summary = `${action} ${dimension}`;
  }

  return {
    filename,
    path: filePath,
    mtime: existsSync(filePath) ? statSync(filePath).mtimeMs : 0,
    source,
    createdAt,
    timestamp,
    dimension,
    action,
    synthesizedBy,
    summary,
    body,
  };
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Move a proposal to the accepted/ directory.
 * Creates the directory if it doesn't exist.
 */
export function acceptProposal(proposal: Proposal, acceptedDir: string): void {
  ensureDir(acceptedDir);
  renameSync(proposal.path, join(acceptedDir, proposal.filename));
}

/**
 * Move a proposal to the rejected/ directory.
 * Creates the directory if it doesn't exist.
 */
export function rejectProposal(proposal: Proposal, rejectedDir: string): void {
  ensureDir(rejectedDir);
  renameSync(proposal.path, join(rejectedDir, proposal.filename));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  try {
    const parsed = load(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace(".000Z", "Z");
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
