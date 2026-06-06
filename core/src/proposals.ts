// core/src/proposals.ts — Proposal type and file operations
//
// Used by: draft-cli (commands/proposals.ts), draft-desktop (proposals UI)
// Interactive UI logic (keypress reader, rendering) stays in CLI — only data
// operations live here so the desktop can reuse them.

import { existsSync, readdirSync, renameSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ContextUpdate {
  file: string;
  action: string;
  content: string;
}

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
  /** Full file text including YAML frontmatter — for "View raw". */
  rawContent: string;
  /** Content of the first context_update — used for diff preview. */
  content: string;
  /** All parsed context_updates from the frontmatter. */
  contextUpdates: ContextUpdate[];
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
  let fileContent = "";
  try {
    fileContent = readFileSync(filePath, "utf8");
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
  let contextUpdates: ContextUpdate[] = [];

  const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = parseFrontmatter(fmMatch[1] ?? "");
    source = stringField(fm.source) || stringField(fm.input_source) || source;
    createdAt = stringField(fm.created_at) || stringField(fm.createdAt) || createdAt;
    timestamp = stringField(fm.timestamp) || createdAt;
    dimension = stringField(fm.dimension) || firstContextUpdateDimension(fm) || dimension;
    action = stringField(fm.action) || firstContextUpdateAction(fm) || action;
    synthesizedBy = stringField(fm.synthesized_by) || stringField(fm.synthesizedBy) || synthesizedBy;
    summary = stringField(fm.summary) || summary;

    const updates = fm.context_updates;
    if (Array.isArray(updates)) {
      contextUpdates = updates
        .filter((u): u is Record<string, unknown> => u !== null && typeof u === "object")
        .map((u) => ({
          file: stringField(u.file),
          action: stringField(u.action) || "append",
          content: stringField(u.content),
        }))
        .filter((u) => u.file);
    }
  }

  const body = fmMatch ? fileContent.slice(fmMatch[0].length).trim() : fileContent.trim();
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
    rawContent: fileContent,
    content: contextUpdates[0]?.content ?? "",
    contextUpdates,
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

/**
 * Apply a proposal's context_updates to the local workspace files.
 * This is what makes Accept actually do something — without this,
 * accepting only moves the file to accepted/ with no effect on context.
 *
 * Actions:
 *   append  — appends content to the target context file
 *   overwrite — overwrites the target context file (curator-triggered compaction only)
 *   tension — appends to context/tensions.md regardless of the file field
 */
export function applyProposalLocally(proposal: Proposal, workspacePath: string): void {
  for (const update of proposal.contextUpdates) {
    if (!update.content) continue;

    if (update.action === "tension") {
      const tensionsPath = join(workspacePath, "context", "tensions.md");
      ensureDir(join(workspacePath, "context"));
      appendFileSync(tensionsPath, "\n" + update.content + "\n", "utf8");
    } else if (update.action === "overwrite") {
      const targetPath = join(workspacePath, update.file);
      ensureDir(join(workspacePath, ...update.file.split("/").slice(0, -1)));
      writeFileSync(targetPath, update.content + "\n", "utf8");
    } else {
      // append (default)
      const targetPath = join(workspacePath, update.file);
      mkdirSync(join(workspacePath, ...update.file.split("/").slice(0, -1)), { recursive: true });
      appendFileSync(targetPath, "\n" + update.content + "\n", "utf8");
    }
  }
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

function firstContextUpdateDimension(fm: Record<string, unknown>): string {
  const updates = fm.context_updates;
  if (!Array.isArray(updates) || updates.length === 0) return "";
  const first = updates[0] as Record<string, unknown>;
  const file = stringField(first?.file); // e.g. "context/product/index.md"
  const match = file.match(/context\/([^/]+)\//);
  return match?.[1] ?? "";
}

function firstContextUpdateAction(fm: Record<string, unknown>): string {
  const updates = fm.context_updates;
  if (!Array.isArray(updates) || updates.length === 0) return "";
  const first = updates[0] as Record<string, unknown>;
  return stringField(first?.action);
}

function stringField(value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace(".000Z", "Z");
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
