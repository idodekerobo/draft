import type { DocumentLastChange } from "../../../services/context-history";

/** A context file as the prompt lists it. */
export interface ListedContextFile {
  logicalPath: string;
  readPath: string;
  sha256: string;
}

/** Memory day and week files this many days old, or older, are left out of the list. They stay readable by path. */
export const MEMORY_LIST_DAYS = 14;

const DAY_FILE = /^memory\/days\/(\d{4}-\d{2}-\d{2})\.md$/;
const WEEK_FILE = /^memory\/weeks\/(\d{4}-\d{2}-\d{2})\.md$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The end of a memory file's period, as a time, or null for a file that is not a day or week file. */
function periodEnd(path: string): number | null {
  const day = path.match(DAY_FILE);
  if (day) return Date.parse(`${day[1]}T23:59:59.999Z`);
  const week = path.match(WEEK_FILE);
  // A week file is named for its Monday, and the week ends six days later.
  if (week) return Date.parse(`${week[1]}T23:59:59.999Z`) + 6 * DAY_MS;
  return null;
}

/**
 * Keeps every file except old memory day and week files. Months, the memory index and all other documents stay,
 * so the list does not grow by one file a day for ever.
 */
export function capMemoryFiles<T extends { logicalPath: string }>(files: ReadonlyArray<T>, now: Date): { listed: T[]; omitted: number } {
  const cutoff = now.getTime() - MEMORY_LIST_DAYS * DAY_MS;
  const listed: T[] = [];
  let omitted = 0;
  for (const file of files) {
    const end = periodEnd(file.logicalPath);
    if (end !== null && end < cutoff) omitted += 1;
    else listed.push(file);
  }
  return { listed, omitted };
}

const dateOf = (iso: string): string => iso.slice(0, 10);

/** How old a document's last change is, as the prompt says it. */
function ageOf(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return "today";
  if (days === 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The part of a file's entry that says when it last changed and who changed it. */
export function lastChangedLine(change: DocumentLastChange | undefined, scanned: number, now: Date): string {
  if (!change) return `last changed: more than ${scanned} versions ago, so it may be stale`;
  const by = change.agentRunId ? `by run ${change.agentRunId}` : `(${change.creationReason})`;
  return `last changed: ${dateOf(change.createdAt)}, ${ageOf(change.createdAt, now)}, ${by}`;
}

/**
 * The list of context files for a prompt. Each entry gives one path to read from, the hash to pass as `baseSha`,
 * and when the document last changed. Old memory day and week files are left out, with a note.
 */
export function renderContextListing(
  files: ReadonlyArray<ListedContextFile>,
  lastChanged: ReadonlyMap<string, DocumentLastChange>,
  scanned: number,
  now: Date,
): string {
  const { listed, omitted } = capMemoryFiles(files, now);
  const lines = listed.map((file) => `- ${file.logicalPath}\n  read from: ${file.readPath}\n  sha256: ${file.sha256}\n  ${lastChangedLine(lastChanged.get(file.logicalPath), scanned, now)}`);
  if (omitted > 0) lines.push(`(${omitted} older memory day and week files are not listed. Read one with context.read and its path.)`);
  return lines.join("\n") || "(no existing context)";
}
