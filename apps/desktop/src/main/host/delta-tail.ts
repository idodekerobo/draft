import { closeSync, fstatSync, openSync, readSync, rmSync, statSync, truncateSync } from "fs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const POLL_MS = 30;

export interface DeltaTailOptions {
  path: string;
  onPayload: (payload: Record<string, unknown>) => void;
  pollMs?: number;
}

/** Reads the JSON lines that the hook script appends to a file, as the lines arrive. */
export class DeltaTail {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DeltaTailOptions) {}

  /** Starts at the current end of the file, so lines written before this call are never replayed. */
  start(): void {
    this.offset = sizeOf(this.options.path);
    if (this.timer === null) this.timer = setInterval(() => this.poll(), this.options.pollMs ?? POLL_MS);
  }

  poll(): void {
    const { path } = this.options;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    let size: number;
    try {
      size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0;
      const chunk = Buffer.alloc(size - this.offset);
      const read = readSync(fd, chunk, 0, chunk.length, this.offset);
      const lastNewline = chunk.subarray(0, read).lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        this.offset += lastNewline + 1;
        for (const line of chunk.toString("utf8", 0, lastNewline).split("\n")) this.deliver(line);
      }
    } finally {
      closeSync(fd);
    }
    if (this.offset === size && size > MAX_FILE_BYTES) {
      truncateSync(path, 0);
      this.offset = 0;
    }
  }

  stop(remove = false): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (remove) rmSync(this.options.path, { force: true });
  }

  private deliver(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    try {
      this.options.onPayload(payload as Record<string, unknown>);
    } catch (error) {
      console.error("[delta-tail] handler failed", error);
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
