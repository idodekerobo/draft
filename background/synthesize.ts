// background/synthesize.ts — Draft synthesis router
//
// Reads a job file, checks eligibility, delegates to the source adapter bash script,
// handles timeout, writes output to proposals/, and records the run in activity.db.
// Job file cleanup (unlinkSync/renameSync) is the caller's responsibility.

import { openActivityDb, insertRun, type ActivityRun } from 'draft-core/db/activity';
import { BACKGROUND_DIR, getWorkspacePath } from 'draft-core/config';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync } from 'fs';
import { basename, join } from 'path';

export interface SynthesizeResult {
  status: 'success' | 'failed' | 'skipped' | 'timeout';
  proposalsGenerated: number;
  errorMsg?: string;
  skipReason?: string;
}

interface Job {
  session_id?: string;
  reason?: string;
  profile?: string;
  source?: string;
  cwd?: string;
}

const LOGS_DIR   = `${BACKGROUND_DIR}/logs`;
const LOG_PATH   = `${LOGS_DIR}/daemon.log`;
const TIMEOUT_MS = 300_000;

function slog(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
}

function countProposalFiles(stagingDir: string): number {
  try {
    return readdirSync(stagingDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .length;
  } catch {
    return 0; // ENOENT or unreadable — treat as empty
  }
}

function writeActivityRow(workspace: string, run: ActivityRun): void {
  try {
    mkdirSync(workspace, { recursive: true });
    const db = openActivityDb(workspace);
    insertRun(db, run);
    db.close();
  } catch (e) {
    slog('warn', `synthesize: failed to write activity row: ${e}`);
  }
}

export async function synthesize(jobPath: string): Promise<SynthesizeResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  // Job UUID from filename — used as row id so duplicate job runs are idempotent
  const jobId = basename(jobPath).replace(/^job-/, '').replace(/\.json$/, '');

  // ── Parse job ──────────────────────────────────────────────────────────────
  let job: Job;
  try {
    job = JSON.parse(await Bun.file(jobPath).text()) as Job;
  } catch {
    // Can't determine profile — no DB write
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job JSON' };
  }

  const profile      = job.profile    ?? 'default';
  const sessionId    = job.session_id ?? null;
  const reason       = job.reason     ?? 'unknown';
  const source       = job.source     ?? 'claude-code-session';
  const cwd          = job.cwd        ?? null;
  const sessionShort = sessionId ? sessionId.slice(0, 8) : 'unknown';
  const workspace    = getWorkspacePath(profile);

  // ── Skip exits that indicate broken/missing transcripts ─────────────────────
  // 'other' (Ctrl+C) and 'prompt_input_exit' (clean exit) both have usable
  // transcripts. Skip only reasons where synthesis would produce noise.
  const SKIP_REASONS = new Set(['clear', 'resume', 'logout', 'bypass_permissions_disabled']);
  if (SKIP_REASONS.has(reason)) {
    slog('info', `synthesize: skipping job (reason=${reason} session=${sessionShort} profile=${profile})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd,
      startedAt, endedAt: new Date().toISOString(), status: 'skipped',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: reason, errorMsg: null,
    });
    return { status: 'skipped', proposalsGenerated: 0, skipReason: reason };
  }

  slog('info', `synthesize: starting (session=${sessionShort} profile=${profile})`);

  // ── Resolve adapter script ─────────────────────────────────────────────────
  const adapterScript = join(BACKGROUND_DIR, 'synthesizers', `${source}.sh`);
  if (!existsSync(adapterScript)) {
    const msg = `source adapter not found: ${adapterScript} (session=${sessionShort})`;
    slog('error', `synthesize: ${msg}`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd,
      startedAt, endedAt: new Date().toISOString(), status: 'failed',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: msg,
    });
    return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
  }

  // ── Count proposals before spawn (ENOENT-safe) ────────────────────────────
  const stagingDir  = join(workspace, 'proposals');
  const countBefore = countProposalFiles(stagingDir);

  // ── Spawn adapter with 300s timeout ───────────────────────────────────────
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFd = openSync(LOG_PATH, 'a');

  const proc = Bun.spawn(['bash', adapterScript, jobPath], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: logFd,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Kill process group so grandchildren (e.g. `claude -p` inside the adapter) are cleaned up
    if (proc.pid) {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    }
    proc.kill();
  }, TIMEOUT_MS);

  const [exitCode, stdoutText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  clearTimeout(timer);
  closeSync(logFd);

  if (timedOut) {
    slog('error', `synthesize: timeout after 300s (session=${sessionShort})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd,
      startedAt, endedAt: new Date().toISOString(), status: 'timeout',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: 'timed out after 300s',
    });
    return { status: 'timeout', proposalsGenerated: 0, errorMsg: 'timed out after 300s' };
  }

  if (exitCode !== 0) {
    const errorMsg = `adapter exited ${exitCode}`;
    slog('error', `synthesize: ${errorMsg} (session=${sessionShort})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd,
      startedAt, endedAt: new Date().toISOString(), status: 'failed',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg,
    });
    return { status: 'failed', proposalsGenerated: 0, errorMsg };
  }

  // ── Validate output ────────────────────────────────────────────────────────
  if (!stdoutText.trim() || stdoutText.includes('context_updates: []')) {
    const why = !stdoutText.trim() ? 'empty output' : 'no team-relevant updates';
    slog('info', `synthesize: ${why} (session=${sessionShort}) — nothing to stage`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd,
      startedAt, endedAt: new Date().toISOString(), status: 'success',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: null,
    });
    return { status: 'success', proposalsGenerated: 0 };
  }

  // ── Write to proposals/ ────────────────────────────────────────────────────
  mkdirSync(join(stagingDir, 'accepted'), { recursive: true });
  mkdirSync(join(stagingDir, 'rejected'), { recursive: true });

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts  = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
              `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const stagingFile = join(stagingDir, `${ts}-${sessionShort}.md`);

  await Bun.write(stagingFile, stdoutText);
  slog('info', `synthesize: staged at ${stagingFile} (session=${sessionShort} profile=${profile})`);

  // ── Record success row ─────────────────────────────────────────────────────
  const proposalsGenerated = Math.max(0, countProposalFiles(stagingDir) - countBefore);
  writeActivityRow(workspace, {
    id: jobId, profile, source, sessionId, cwd,
    startedAt, endedAt: new Date().toISOString(), status: 'success',
    durationMs: Date.now() - startTime,
    proposalsGenerated, skipReason: null, errorMsg: null,
  });

  return { status: 'success', proposalsGenerated };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (import.meta.main) {
  void (async () => {
    const jobPath = process.argv[2];
    if (!jobPath) {
      console.error('Usage: bun synthesize.ts <job-path>');
      process.exit(1);
    }
    const result = await synthesize(jobPath);
    process.exit(result.status === 'failed' || result.status === 'timeout' ? 1 : 0);
  })();
}
