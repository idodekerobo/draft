// core/src/sync/atomic-write.ts — atomic tmp→fdatasync→rename write with content-hash OCC and backup

import {
  openSync, readFileSync, writeSync, closeSync, renameSync, mkdirSync,
  readdirSync, unlinkSync, statSync, fdatasyncSync, constants,
} from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".draft", "state");
const LOCK_PATH = join(STATE_DIR, "write.lock");
const MAX_DAILY_BACKUPS = 7;

export class ParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Draft: failed to parse ${filePath}: ${cause}`);
    this.name = "ParseError";
  }
}

export class ConcurrencyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConcurrencyError";
  }
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Rotate daily backups — keep at most MAX_DAILY_BACKUPS per base file.
 * Backup files match pattern: `{filePath}.draft-bak-YYYY-MM-DD`
 */
function rotateDailyBackups(filePath: string): void {
  const dir = dirname(filePath);
  const base = filePath.split("/").pop()!;
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.draft-bak-`) && f.match(/\d{4}-\d{2}-\d{2}$/))
      .sort();
    if (entries.length >= MAX_DAILY_BACKUPS) {
      const toDelete = entries.slice(0, entries.length - MAX_DAILY_BACKUPS + 1);
      for (const name of toDelete) {
        try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

function writeBackup(filePath: string, content: Buffer): void {
  try {
    const prevPath = `${filePath}.draft-bak-previous`;
    const prevFd = openSync(prevPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try { writeSync(prevFd, content); } finally { closeSync(prevFd); }
  } catch { /* best effort */ }

  try {
    const today = todayStr();
    const dailyPath = `${filePath}.draft-bak-${today}`;
    // Write daily backup once per calendar day
    let needsWrite = true;
    try { statSync(dailyPath); needsWrite = false; } catch { /* doesn't exist yet */ }
    if (needsWrite) {
      rotateDailyBackups(filePath);
      const dailyFd = openSync(dailyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
      try { writeSync(dailyFd, content); } finally { closeSync(dailyFd); }
    }
  } catch { /* best effort */ }
}

/**
 * Atomically patch a file:
 *   1. Read → hash → call patchFn
 *   2. If no semantic change, return (no-op)
 *   3. Re-read to verify no external write; retry up to 3x
 *   4. Write backup, then tmp→fdatasync→rename → best-effort parent-dir fsync
 *
 * patchFn receives the raw text and must return the patched text.
 * If patchFn throws ParseError, the blocked state is the caller's responsibility to set.
 *
 * Advisory flock is attempted but skipped if unavailable (Bun limitation on some platforms).
 */
export async function atomicPatch(
  filePath: string,
  patchFn: (rawText: string) => string,
  opts?: { mode?: number },
): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

  // Try to acquire advisory flock. Bun may not expose flock — skip if unavailable.
  let lockFd: number | null = null;
  try {
    lockFd = openSync(LOCK_PATH, constants.O_WRONLY | constants.O_CREAT, 0o600);
    // node:fs doesn't expose flock directly; attempt via platform-specific path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fsExtra = (await import("node:fs").then((m) => m).catch(() => null)) as any;
    if (fsExtra?.flock) fsExtra.flock(lockFd, 2 /* LOCK_EX */);
  } catch {
    // flock unavailable — document: daemon is sole writer in practice
  }

  try {
    let lastContent: Buffer | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let rawContent: Buffer;
      try {
        rawContent = readFileSync(filePath);
      } catch {
        rawContent = Buffer.from("");
      }
      const hash = sha256(rawContent);
      lastContent = rawContent;

      const rawText = rawContent.toString("utf8");
      let patched: string;
      try {
        patched = patchFn(rawText);
      } catch (e) {
        if (e instanceof ParseError) throw e;
        throw new ParseError(filePath, e);
      }

      if (patched === rawText) return; // semantic no-op

      // Re-read to check for external writes
      let rawContent2: Buffer;
      try {
        rawContent2 = readFileSync(filePath);
      } catch {
        rawContent2 = Buffer.from("");
      }
      if (sha256(rawContent2) !== hash) {
        lastContent = rawContent2;
        continue; // external write — retry
      }

      writeBackup(filePath, rawContent);

      const tmp = `${filePath}.draft-tmp-${process.pid}`;
      const mode = opts?.mode ?? 0o600;
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
      try {
        writeSync(fd, patched, 0, "utf8");
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }

      renameSync(tmp, filePath);

      // Best-effort parent-dir fsync (durability of the rename itself)
      try {
        const dirFd = openSync(dirname(filePath), constants.O_RDONLY);
        try { fdatasyncSync(dirFd); } catch { /* best effort */ } finally { closeSync(dirFd); }
      } catch { /* best effort */ }

      return;
    }

    throw new ConcurrencyError(
      `atomicPatch: failed after 3 attempts on ${filePath} — external writer holding file`,
    );
  } finally {
    if (lockFd !== null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fsExtra = (await import("node:fs").then((m) => m).catch(() => null)) as any;
        if (fsExtra?.flock) fsExtra.flock(lockFd, 8 /* LOCK_UN */);
      } catch { /* best effort */ }
      try { closeSync(lockFd); } catch { /* best effort */ }
    }
  }
}
