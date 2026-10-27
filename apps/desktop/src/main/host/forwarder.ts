import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import type { FileCursor } from "./cursor-store";

export interface ForwardedLine {
  file: string;
  offset: number;
  raw?: string;
  /** Set instead of `raw` when the line is too large to post. */
  oversizeBytes?: number;
}

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
export const ROOT_FILE = "root.jsonl";
const READ_BYTES = 2 * 1024 * 1024;
const SCAN_BYTES = 1024 * 1024;
// The route caps a request body at 5 MiB; stay under it with room for the wrapper.
const MAX_POST_BYTES = 4 * 1024 * 1024;
const FINGERPRINT_BYTES = 256;
const SEEN_IDS_KEPT = 200;
const POLL_MS = 500;
const MAX_BACKOFF_MS = 15_000;

const emptyCursor = (): FileCursor => ({ offset: 0, fingerprint: "", seenIds: [] });

function readRange(path: string, start: number, length: number): Buffer {
  const chunk = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, chunk, 0, length, start);
    return read === length ? chunk : chunk.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function fingerprintBefore(path: string, offset: number): string {
  if (offset === 0) return "";
  const start = Math.max(0, offset - FINGERPRINT_BYTES);
  return createHash("sha1").update(readRange(path, start, offset - start)).digest("hex");
}

/** Complete lines in a chunk that starts at `startOffset`. A trailing partial line is left for the next read. */
export function readCompleteLines(chunk: Buffer, startOffset: number, file = ROOT_FILE): { lines: ForwardedLine[]; consumed: number } {
  const lines: ForwardedLine[] = [];
  let lineStart = 0;
  for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, lineStart)) {
    const raw = chunk.toString("utf8", lineStart, i);
    if (raw.trim()) lines.push({ file, offset: startOffset + lineStart, raw });
    lineStart = i + 1;
  }
  return { lines, consumed: lineStart };
}

/** Position of the next newline at or after `from`, or -1 when the file ends first. */
function findNewline(path: string, from: number, size: number): number {
  for (let at = from; at < size; at += SCAN_BYTES) {
    const block = readRange(path, at, Math.min(SCAN_BYTES, size - at));
    const index = block.indexOf(0x0a);
    if (index !== -1) return at + index;
  }
  return -1;
}

const serializedBytes = (line: ForwardedLine) => Buffer.byteLength(JSON.stringify(line));

function nativeUuid(raw: string): string | null {
  try {
    const uuid = (JSON.parse(raw) as { uuid?: unknown }).uuid;
    return typeof uuid === "string" ? uuid : null;
  } catch {
    return null;
  }
}

/** Claude names its project folder after the cwd (hashed when long), so find the file by its session id. */
export function findTranscript(nativeSessionId: string, projectsDir = CLAUDE_PROJECTS_DIR): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${nativeSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ForwarderOptions {
  nativeSessionId: string;
  cursors: Record<string, FileCursor>;
  /** Called with every cursor after each successful post, to persist them. */
  onCursors: (cursors: Record<string, FileCursor>) => void;
  post: (lines: ForwardedLine[]) => Promise<void>;
  /** Return true when the failure means this session can never accept lines again. */
  isFatal: (error: unknown) => boolean;
  onFatal: (error: unknown) => void;
  locate?: (nativeSessionId: string) => string | null;
  pollMs?: number;
}

export class TranscriptForwarder {
  private cursors: Record<string, FileCursor>;
  private rootPath: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private backoffMs = 0;
  private stopped = false;

  constructor(private readonly options: ForwarderOptions) {
    this.cursors = structuredClone(options.cursors);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling. */
  halt(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The transcript files seen so far, for the raw upload. */
  files(): Array<{ label: string; path: string }> {
    this.rootPath ??= (this.options.locate ?? findTranscript)(this.options.nativeSessionId);
    if (!this.rootPath) return [];
    return [{ label: ROOT_FILE, path: this.rootPath }, ...this.subagentFiles()];
  }

  private subagentDir(): string | null {
    return this.rootPath ? join(dirname(this.rootPath), this.options.nativeSessionId, "subagents") : null;
  }

  private subagentFiles(): Array<{ label: string; path: string }> {
    const dir = this.subagentDir();
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^agent-.+\.jsonl$/.test(name))
      .sort()
      .map((name) => ({ label: `subagents/${name}`, path: join(dir, name) }));
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule(this.backoffMs || this.options.pollMs || POLL_MS);
    }, delayMs);
  }

  /** Posts everything currently readable, file by file, in order. A cursor moves only after its post succeeds. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      this.rootPath ??= (this.options.locate ?? findTranscript)(this.options.nativeSessionId);
      if (!this.rootPath) return true;
      for (const file of this.files()) await this.drain(file.label, file.path);
      this.backoffMs = 0;
      return true;
    } catch (error) {
      if (this.options.isFatal(error)) {
        this.stopped = true;
        this.options.onFatal(error);
      } else {
        this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.backoffMs || 1000) * 2);
      }
      return false;
    } finally {
      this.running = false;
    }
  }

  private async drain(label: string, path: string): Promise<void> {
    const cursor = (this.cursors[label] ??= emptyCursor());
    const size = statSync(path).size;
    if (cursor.offset > size || fingerprintBefore(path, cursor.offset) !== cursor.fingerprint) {
      cursor.offset = 0;
      cursor.fingerprint = "";
    }

    while (cursor.offset < size) {
      const length = Math.min(size - cursor.offset, READ_BYTES);
      let { lines, consumed } = readCompleteLines(readRange(path, cursor.offset, length), cursor.offset, label);

      if (consumed === 0) {
        if (length === size - cursor.offset) break;
        const end = findNewline(path, cursor.offset + length, size);
        if (end === -1) break;
        const lineBytes = end - cursor.offset;
        const raw = lineBytes <= MAX_POST_BYTES ? readRange(path, cursor.offset, lineBytes).toString("utf8") : null;
        lines = raw !== null ? [{ file: label, offset: cursor.offset, raw }] : [{ file: label, offset: cursor.offset, oversizeBytes: lineBytes }];
        consumed = lineBytes + 1;
      }

      await this.postAll(path, cursor, lines, consumed);
    }
  }

  private async postAll(path: string, cursor: FileCursor, lines: ForwardedLine[], consumed: number): Promise<void> {
    const seen = new Set(cursor.seenIds);
    const fresh = lines.filter((line) => {
      const uuid = line.raw !== undefined ? nativeUuid(line.raw) : null;
      return uuid === null || !seen.has(uuid);
    });

    let batch: ForwardedLine[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length > 0) await this.options.post(batch);
      batch = [];
      batchBytes = 0;
    };

    for (let line of fresh) {
      let bytes = serializedBytes(line);
      if (bytes > MAX_POST_BYTES) {
        line = { file: line.file, offset: line.offset, oversizeBytes: Buffer.byteLength(line.raw ?? "") };
        bytes = serializedBytes(line);
      }
      if (batchBytes + bytes > MAX_POST_BYTES) await flush();
      batch.push(line);
      batchBytes += bytes;
    }
    await flush();

    const ids = fresh.flatMap((line) => (line.raw !== undefined ? [nativeUuid(line.raw)] : [])).filter((id): id is string => id !== null);
    cursor.seenIds = [...cursor.seenIds, ...ids].slice(-SEEN_IDS_KEPT);
    cursor.offset += consumed;
    cursor.fingerprint = fingerprintBefore(path, cursor.offset);
    this.options.onCursors(structuredClone(this.cursors));
  }
}
