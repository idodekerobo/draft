import type { CaptureEntry, ReconcileConflict } from "draft-core/synthesis-steps";
import type { DocumentLastChange } from "../../services/context-history";
import { lastChangedLine, renderContextListing, type ListedContextFile } from "../context-listing";
import type { ValidatedRunBundle } from "../context-version-files";
import { RECONCILE_NEW_DOCUMENTS_PROMPT, RECONCILE_PROMPT } from "./prompts";

const CONTEXT_PREFIX = "input/context/";
const SOURCES_PREFIX = "input/sources/";
/** Entries are shown inline up to this many characters. The rest are in the step's input files. */
const INLINE_ENTRIES_MAX_CHARS = 40_000;

export interface RenderContext {
  bundle: ValidatedRunBundle;
  lastChanged: ReadonlyMap<string, DocumentLastChange>;
  /** How many of the newest versions `lastChanged` was read from. */
  scanned: number;
  now: Date;
}

export function contextFilesOf(bundle: ValidatedRunBundle): Array<ListedContextFile> {
  return Object.entries(bundle.files)
    .filter(([path]) => path.startsWith(CONTEXT_PREFIX))
    .map(([path, file]) => ({ logicalPath: path.slice(CONTEXT_PREFIX.length), readPath: path, sha256: file.sha256 }))
    .sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
}

/** The source files of a bundle. A file is named `NNNN-<source item id>.md`. */
export function sourceFilesOf(bundle: ValidatedRunBundle): Array<{ readPath: string; sourceItemId: string }> {
  return Object.keys(bundle.files)
    .filter((path) => path.startsWith(SOURCES_PREFIX))
    .sort()
    .map((readPath) => ({ readPath, sourceItemId: readPath.slice(SOURCES_PREFIX.length).replace(/^\d+-/, "").replace(/\.md$/, "") }));
}

/** The stable documents: every one that is not memory. */
export const isStablePath = (path: string): boolean => !path.startsWith("memory/");

const rosterLine = (bundle: ValidatedRunBundle): string =>
  "input/people.json" in bundle.files
    ? "The people Draft knows, with their ids and status, are in input/people.json."
    : "Draft has no people on its roster yet.";

const stepFilesLine = (bundle: ValidatedRunBundle): string => {
  const files = Object.keys(bundle.files).filter((path) => path.startsWith("input/steps/")).sort();
  return files.length ? `\n## What the earlier steps produced\nEach file holds one earlier run's answer.\n${files.map((path) => `- ${path}`).join("\n")}\n` : "";
};

function inlineEntries(entries: ReadonlyArray<CaptureEntry>): string {
  const text = JSON.stringify(entries, null, 2);
  return text.length <= INLINE_ENTRIES_MAX_CHARS ? text : `${text.slice(0, INLINE_ENTRIES_MAX_CHARS)}\n… (cut here. The step's input files hold every entry.)`;
}

/** The capture prompt for one batch: the context to check against, and the sources to read. */
export function renderCapturePrompt(template: string, ctx: RenderContext): string {
  const sources = sourceFilesOf(ctx.bundle)
    .map((file) => `- read from: ${file.readPath}\n  source_item_id: ${file.sourceItemId}`)
    .join("\n") || "(no source material)";
  return `${template}

## Existing context (read-only)
${renderContextListing(contextFilesOf(ctx.bundle), ctx.lastChanged, ctx.scanned, ctx.now)}

## New source material to read
${sources}

${rosterLine(ctx.bundle)}
`;
}

/** The reconcile prompt for one document, or for the entries that need new documents. */
export function renderReconcilePrompt(
  template: string,
  ctx: RenderContext,
  target: { type: "document"; path: string } | { type: "new_documents"; suggestedPaths: string[]; bootstrapHints?: Array<{ dimensionName: string; dimensionDescription: string }> },
  entries: ReadonlyArray<CaptureEntry>,
): string {
  const files = contextFilesOf(ctx.bundle);
  const listing = renderContextListing(files, ctx.lastChanged, ctx.scanned, ctx.now);
  if (target.type === "new_documents") {
    const hints = target.bootstrapHints?.length
      ? `\n## Dimensions the team chose to track\nUse them as a starting hint for what documents to create. You decide the names and structure.\n${target.bootstrapHints.map((hint) => `- ${hint.dimensionName}: ${hint.dimensionDescription}`).join("\n")}\n`
      : "";
    const body = template.replace(RECONCILE_PROMPT, RECONCILE_NEW_DOCUMENTS_PROMPT);
    return `${body}

## Entries that need a new document
Paths the capture step suggested: ${target.suggestedPaths.length ? target.suggestedPaths.join(", ") : "(none)"}
${inlineEntries(entries)}
${hints}
## Existing context (read-only)
${listing}
${stepFilesLine(ctx.bundle)}
${rosterLine(ctx.bundle)}
`;
  }
  const file = files.find((entry) => entry.logicalPath === target.path);
  const about = file
    ? `- ${file.logicalPath}\n  read from: ${file.readPath}\n  sha256: ${file.sha256}\n  ${lastChangedLine(ctx.lastChanged.get(file.logicalPath), ctx.scanned, ctx.now)}`
    : `- ${target.path}\n  (this document is not in the bundle)`;
  return `${template}

## The document to check
${about}

## Entries that bear on it
${entries.length ? inlineEntries(entries) : "(none: the whole stable context is being checked)"}

## Other context (read-only)
${listing}
${stepFilesLine(ctx.bundle)}
${rosterLine(ctx.bundle)}
`;
}

/** The organize prompt: every capture entry, and every conflict reconcile could not settle. */
export function renderOrganizePrompt(template: string, ctx: RenderContext, entries: ReadonlyArray<CaptureEntry>, conflicts: ReadonlyArray<ReconcileConflict>, reconcileSummaries: ReadonlyArray<string>): string {
  const conflictText = conflicts.length ? JSON.stringify(conflicts, null, 2) : "(none)";
  const summaries = reconcileSummaries.length ? reconcileSummaries.map((line) => `- ${line}`).join("\n") : "(no document was checked)";
  return `${template}

## Capture entries to write into memory
${entries.length ? inlineEntries(entries) : "(none)"}

## Conflicts the reconcile step could not settle
${conflictText}

## What the reconcile step did
${summaries}

## Existing context (read-only; pass a file's sha256 as baseSha when you write it)
${renderContextListing(contextFilesOf(ctx.bundle), ctx.lastChanged, ctx.scanned, ctx.now)}
${stepFilesLine(ctx.bundle)}
${rosterLine(ctx.bundle)}
`;
}
