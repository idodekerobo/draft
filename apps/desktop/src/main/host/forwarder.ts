import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { join } from "path";

export interface ForwardedLine {
  file: string;
  offset: number;
  raw: string;
}

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
const ROOT_FILE = "root.jsonl";
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LINES_PER_POST = 500;
const POLL_MS = 500;
const MAX_BACKOFF_MS = 15_000;

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
  post: (lines: ForwardedLine[]) => Promise<void>;
  /** Return true when the failure means this session can never accept lines again. */
  isFatal: (error: unknown) => boolean;
  onFatal: (error: unknown) => void;
  locate?: (nativeSessionId: string) => string | null;
  pollMs?: number;
}

export class TranscriptForwarder {
  private offset = 0;
  private path: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private backoffMs = 0;
  private stopped = false;

  constructor(private readonly options: ForwarderOptions) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tick();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule(this.backoffMs || this.options.pollMs || POLL_MS);
    }, delayMs);
  }

  /** Posts everything currently readable, in order. The offset advances only after a post succeeds. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.path ??= (this.options.locate ?? findTranscript)(this.options.nativeSessionId);
      if (!this.path) return;

      const size = statSync(this.path).size;
      if (size < this.offset) this.offset = 0;

      while (this.offset < size) {
        const length = Math.min(size - this.offset, MAX_READ_BYTES);
        const chunk = Buffer.alloc(length);
        const fd = openSync(this.path, "r");
        try {
          readSync(fd, chunk, 0, length, this.offset);
        } finally {
          closeSync(fd);
        }

        const { lines, consumed } = readCompleteLines(chunk, this.offset);
        if (consumed === 0) break;

        for (let i = 0; i < Math.max(lines.length, 1); i += MAX_LINES_PER_POST) {
          const batch = lines.slice(i, i + MAX_LINES_PER_POST);
          if (batch.length > 0) await this.options.post(batch);
        }
        this.offset += consumed;
        this.backoffMs = 0;
      }
    } catch (error) {
      if (this.options.isFatal(error)) {
        this.stopped = true;
        this.options.onFatal(error);
      } else {
        this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.backoffMs || 1000) * 2);
      }
    } finally {
      this.running = false;
    }
  }
}
